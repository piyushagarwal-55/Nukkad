import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@nukkad/db';
import { parseBill } from '../services/bills/parse.js';
import { suggestAliases } from '../services/bills/aliases.js';
import { invalidateCatalog } from '../services/catalog/cache.js';
import { rupeesToPaise } from '@nukkad/shared';

const MEDIA_DIR = join(process.cwd(), 'media');

/**
 * Module 1 hero path. Supplier bill in, catalogue and stock out.
 *
 * Three steps on purpose, because a parser that writes straight to the
 * catalogue with no review is a parser that silently corrupts a shop's
 * prices:
 *   POST /bills/parse    -> read the image, return line items, persist as UPLOADED
 *   POST /bills/:id/commit -> owner has reviewed, create/update SKUs and stock
 *   GET  /bills          -> history
 */
export async function billRoutes(app: FastifyInstance) {
  app.post('/bills/parse', async (req, reply) => {
    const file = await (req as unknown as { file: () => Promise<{
      filename: string; mimetype: string; toBuffer: () => Promise<Buffer>;
    } | undefined> }).file();

    if (!file) return reply.code(400).send({ error: 'no file' });

    const { kiranaId } = (req.query as { kiranaId?: string });
    if (!kiranaId) return reply.code(400).send({ error: 'kiranaId required' });

    const buf = await file.toBuffer();
    await mkdir(MEDIA_DIR, { recursive: true });
    const ext = file.mimetype.includes('png') ? 'png'
              : file.mimetype.includes('pdf') ? 'pdf' : 'jpg';
    const path = join(MEDIA_DIR, `bill_${randomUUID()}.${ext}`);
    await writeFile(path, buf);

    const row = await prisma.supplierBill.create({
      data: { kiranaId, imagePath: path, mime: file.mimetype, bytes: buf.length },
    });

    try {
      const { bill, model, latencyMs } = await parseBill(path, file.mimetype);

      await prisma.supplierBill.update({
        where: { id: row.id },
        data: {
          status: 'PARSED',
          supplierName: bill.supplier,
          billNo: bill.billNo,
          totalPaise: bill.totalPaise,
          visionModel: model,
          parseMs: latencyMs,
          lines: {
            create: bill.items.map((i) => ({
              rawName: i.name,
              quantity: i.qty,
              ratePaise: i.ratePaise,
              amountPaise: i.amountPaise,
            })),
          },
        },
      });

      return { billId: row.id, model, latencyMs, bill };
    } catch (err) {
      await prisma.supplierBill.update({
        where: { id: row.id },
        data: { status: 'FAILED', parseError: (err as Error).message },
      });
      return reply.code(422).send({ error: (err as Error).message, billId: row.id });
    }
  });

  /**
   * Commit. Creates SKUs that do not exist, tops up stock for those that do,
   * records cost price from the bill rate, and asks the LLM for candidate
   * aliases which stay UNAPPROVED until the owner taps them.
   *
   * Selling price is cost plus a default markup, because nobody is typing
   * 400 selling prices by hand.
   */
  app.post('/bills/:id/commit', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { markupPct = 15 } = (req.body ?? {}) as { markupPct?: number };

    const bill = await prisma.supplierBill.findUnique({
      where: { id }, include: { lines: true },
    });
    if (!bill) return reply.code(404).send({ error: 'no such bill' });

    let created = 0, restocked = 0;

    for (const line of bill.lines) {
      const existing = line.skuId
        ? await prisma.sku.findUnique({ where: { id: line.skuId } })
        : await prisma.sku.findFirst({
            where: { kiranaId: bill.kiranaId, name: line.rawName },
          });

      const sellPaise = Math.round(line.ratePaise * (1 + markupPct / 100));

      if (existing) {
        await prisma.sku.update({
          where: { id: existing.id },
          data: { costPaise: line.ratePaise },
        });
        await prisma.stock.upsert({
          where: { skuId: existing.id },
          create: { skuId: existing.id, quantity: line.quantity },
          update: { quantity: { increment: line.quantity } },
        });
        restocked++;
        continue;
      }

      const sku = await prisma.sku.create({
        data: {
          kiranaId: bill.kiranaId,
          name: line.rawName,
          sellPaise,
          costPaise: line.ratePaise,
          stock: { create: { quantity: line.quantity } },
        },
      });

      // Suggested, never auto-approved. The owner taps.
      const aliases = await suggestAliases(line.rawName);
      if (aliases.length) {
        await prisma.skuAlias.createMany({
          data: aliases.map((a) => ({ skuId: sku.id, alias: a, source: 'LLM_SUGGESTED' as const })),
          skipDuplicates: true,
        });
      }

      await prisma.supplierBillLine.update({
        where: { id: line.id }, data: { skuId: sku.id },
      });
      created++;
    }

    await prisma.supplierBill.update({
      where: { id }, data: { status: 'COMMITTED', committedAt: new Date() },
    });
    invalidateCatalog(bill.kiranaId);

    return { ok: true, created, restocked };
  });

  app.get('/bills', async (req) => {
    const { kiranaId } = req.query as { kiranaId?: string };
    if (!kiranaId) return { bills: [] };
    return {
      bills: await prisma.supplierBill.findMany({
        where: { kiranaId },
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { lines: true } } },
        take: 50,
      }),
    };
  });

  /** Alias approval. One tap each, which is the whole point. */
  app.post('/aliases/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    const row = await prisma.skuAlias.update({
      where: { id }, data: { approved: true },
    });
    await syncAliasArray(row.skuId);
    return { ok: true };
  });

  app.delete('/aliases/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = await prisma.skuAlias.delete({ where: { id } });
    await syncAliasArray(row.skuId);
    return { ok: true };
  });
}

/**
 * Sku.aliases is a denormalised string[] because the ranker reads it on
 * every message and must not do a join per SKU. SkuAlias is the source of
 * truth; this keeps the fast path in sync.
 */
async function syncAliasArray(skuId: string): Promise<void> {
  const rows = await prisma.skuAlias.findMany({
    where: { skuId, approved: true }, select: { alias: true },
  });
  const sku = await prisma.sku.update({
    where: { id: skuId },
    data: { aliases: rows.map((r) => r.alias) },
  });
  invalidateCatalog(sku.kiranaId);
}
