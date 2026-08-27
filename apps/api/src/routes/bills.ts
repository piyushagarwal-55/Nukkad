import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@nukkad/db';
import { planBill } from '../services/bills/graph.js';
import { invalidateCatalog } from '../services/catalog/cache.js';
import { syncAliasArray } from '../services/catalog/aliases.js';
import { requireSession } from './auth.js';

const MEDIA_DIR = join(process.cwd(), 'media');

/**
 * Module 1 hero path. Supplier bill in, catalogue and stock out.
 *
 * Three steps on purpose, because a parser that writes straight to the
 * catalogue with no review is a parser that silently corrupts a shop's
 * prices:
 *
 *   POST /bills/parse      -> run the agent graph, persist a PLAN
 *   GET  /bills/:id/plan   -> the plan and the agent's trace, for review
 *   POST /bills/:id/commit -> owner has reviewed, apply it
 */

const commitSchema = z.object({
  /**
   * Required when the bill reads as RETAIL.
   *
   * A retail receipt is a SALE: those goods left the shelf. Restocking from
   * one inflates the catalogue by exactly the amount just sold, and nobody
   * notices until the shelf disagrees with the screen. A kirana buying from
   * a cash-and-carry genuinely does hold a retail receipt for its own
   * purchase, so this is not refusable -- it is confirmable, once, by the
   * person who knows which it was.
   */
  confirmPurchase: z.boolean().optional(),
  lines: z.array(z.object({
    id: z.string(),
    decision: z.enum(['RESTOCK', 'NEW', 'AMBIGUOUS', 'SKIPPED']),
    skuId: z.string().nullable().optional(),
    sellPaise: z.number().int().nonnegative().optional(),
    quantity: z.number().nonnegative().optional(),
    aliases: z.array(z.string().min(1).max(60)).max(12).optional(),
  })).optional(),
});

export async function billRoutes(app: FastifyInstance) {
  app.post('/bills/parse', async (req, reply) => {
    const file = await (req as unknown as { file: () => Promise<{
      filename: string; mimetype: string; toBuffer: () => Promise<Buffer>;
    } | undefined> }).file();

    if (!file) return reply.code(400).send({ error: 'no file' });

    const { kiranaId } = requireSession(req);

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
      const result = await planBill({
        billId: row.id, kiranaId, imagePath: path, mime: file.mimetype,
      });

      if (result.failure) {
        await prisma.supplierBill.update({
          where: { id: row.id },
          data: { status: 'FAILED', parseError: result.failure },
        });
        return reply.code(422).send({ error: result.failure, billId: row.id, steps: result.steps });
      }

      return { billId: row.id, ...(await readPlan(row.id, kiranaId)) };
    } catch (err) {
      await prisma.supplierBill.update({
        where: { id: row.id },
        data: { status: 'FAILED', parseError: (err as Error).message },
      });
      return reply.code(422).send({ error: (err as Error).message, billId: row.id });
    }
  });

  /** The plan and the trace, so a reload does not lose the review. */
  app.get('/bills/:id/plan', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { id } = req.params as { id: string };
    const plan = await readPlan(id, kiranaId);
    if (!plan) return reply.code(404).send({ error: 'no such bill' });
    return { billId: id, ...plan };
  });

  /**
   * Apply the reviewed plan.
   *
   * Overrides from the review screen win over the agent: the owner is the
   * authority and the agent is a proposal. An AMBIGUOUS line the owner did
   * not resolve is SKIPPED, never guessed.
   */
  app.post('/bills/:id/commit', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { id } = req.params as { id: string };

    const parsed = commitSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad body' });
    const overrides = new Map((parsed.data.lines ?? []).map((l) => [l.id, l]));

    const bill = await prisma.supplierBill.findFirst({
      where: { id, kiranaId }, include: { lines: true },
    });
    if (!bill) return reply.code(404).send({ error: 'no such bill' });
    if (bill.status === 'COMMITTED') {
      return reply.code(409).send({ error: 'This bill has already been applied.' });
    }

    if (bill.docType === 'RETAIL' && !parsed.data.confirmPurchase) {
      return reply.code(409).send({
        error:
          'This reads as a retail receipt, which is a sale rather than a delivery. ' +
          'Applying it would add stock that just left the shelf. Confirm it really is ' +
          'something you bought before it is applied.',
        needsConfirmation: 'RETAIL',
      });
    }

    let created = 0, restocked = 0, skipped = 0, aliasesAdded = 0;
    const touched: string[] = [];

    for (const line of bill.lines) {
      const o = overrides.get(line.id);
      const decision = o?.decision ?? line.decision;
      const skuId = o?.skuId !== undefined ? o.skuId : line.skuId;
      const qty = o?.quantity ?? line.quantity;
      const sellPaise = o?.sellPaise ?? line.proposedSellPaise ?? line.ratePaise;
      const aliases = o?.aliases ?? line.suggestedAliases;

      // an unresolved ambiguity is left alone. Guessing here is exactly the
      // failure this whole graph exists to avoid.
      if (decision === 'SKIPPED' || (decision === 'AMBIGUOUS' && !skuId)) {
        skipped++;
        continue;
      }

      if ((decision === 'RESTOCK' || decision === 'AMBIGUOUS') && skuId) {
        const owned = await prisma.sku.findFirst({ where: { id: skuId, kiranaId } });
        if (!owned) { skipped++; continue; }

        await prisma.sku.update({
          where: { id: skuId },
          data: { costPaise: line.ratePaise, sellPaise },
        });
        await prisma.stock.upsert({
          where: { skuId },
          create: { skuId, quantity: qty },
          update: { quantity: { increment: qty } },
        });

        // a restock can still TEACH the catalogue: a bill that spells a
        // product differently is a new way customers might say it too
        aliasesAdded += await addAliases(skuId, aliases);
        touched.push(skuId);
        await prisma.supplierBillLine.update({ where: { id: line.id }, data: { skuId } });
        restocked++;
        continue;
      }

      const sku = await prisma.sku.create({
        data: {
          kiranaId,
          name: line.rawName,
          sellPaise,
          costPaise: line.ratePaise,
          stock: { create: { quantity: qty } },
        },
      });
      aliasesAdded += await addAliases(sku.id, aliases);
      touched.push(sku.id);
      await prisma.supplierBillLine.update({ where: { id: line.id }, data: { skuId: sku.id } });
      created++;
    }

    for (const skuId of new Set(touched)) await syncAliasArray(skuId);

    await prisma.supplierBill.update({
      where: { id }, data: { status: 'COMMITTED', committedAt: new Date() },
    });
    invalidateCatalog(kiranaId);

    return { ok: true, created, restocked, skipped, aliasesAdded };
  });

  app.get('/bills', async (req) => {
    const { kiranaId } = requireSession(req);
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
  app.post('/aliases/:id/approve', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { id } = req.params as { id: string };

    const owned = await prisma.skuAlias.findFirst({ where: { id, sku: { kiranaId } } });
    if (!owned) return reply.code(404).send({ error: 'no such alias' });

    await prisma.skuAlias.update({ where: { id }, data: { approved: true } });
    await syncAliasArray(owned.skuId);
    return { ok: true };
  });

  app.delete('/aliases/:id', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { id } = req.params as { id: string };

    const owned = await prisma.skuAlias.findFirst({ where: { id, sku: { kiranaId } } });
    if (!owned) return reply.code(404).send({ error: 'no such alias' });

    await prisma.skuAlias.delete({ where: { id } });
    await syncAliasArray(owned.skuId);
    return { ok: true };
  });
}

/** Approved on arrival: these were reviewed by the owner before commit. */
async function addAliases(skuId: string, aliases: string[]): Promise<number> {
  const clean = [...new Set(aliases.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) return 0;

  const res = await prisma.skuAlias.createMany({
    data: clean.map((alias) => ({ skuId, alias, source: 'LLM_SUGGESTED' as const, approved: true })),
    skipDuplicates: true,
  });
  return res.count;
}

async function readPlan(billId: string, kiranaId: string) {
  const bill = await prisma.supplierBill.findFirst({
    where: { id: billId, kiranaId },
    include: {
      lines: { orderBy: { id: 'asc' } },
      steps: { orderBy: { seq: 'asc' } },
    },
  });
  if (!bill) return null;

  return {
    status: bill.status,
    docType: bill.docType,
    supplier: bill.supplierName,
    billNo: bill.billNo,
    totalPaise: bill.totalPaise,
    agentMs: bill.agentMs,
    steps: bill.steps.map((s) => ({
      node: s.node, status: s.status, ms: s.ms, note: s.note, detail: s.detail,
    })),
    lines: bill.lines.map((l) => ({
      id: l.id,
      rawName: l.rawName,
      quantity: l.quantity,
      ratePaise: l.ratePaise,
      amountPaise: l.amountPaise,
      decision: l.decision,
      confidence: l.confidence,
      reasoning: l.reasoning,
      skuId: l.skuId,
      candidates: l.candidatesJson,
      priceDeltaPaise: l.priceDeltaPaise,
      proposedSellPaise: l.proposedSellPaise,
      suggestedAliases: l.suggestedAliases,
      disputed: l.disputed,
      disputeNote: l.disputeNote,
      workingName: l.workingName,
      gloss: l.gloss,
      unit: l.unit,
      pack: l.pack,
      mrpPaise: l.mrpPaise,
      listPricePaise: l.listPricePaise,
      discPct: l.discPct,
      taxPct: l.taxPct,
      isFree: l.isFree,
      derived: l.derived,
    })),
  };
}
