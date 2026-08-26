import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { prisma } from '@nukkad/db';
import { env } from '../config/env.js';
import { requireSession } from './auth.js';
import { invalidateCatalog } from '../services/catalog/cache.js';

const patchSku = z.object({
  sellPaise: z.number().int().nonnegative().optional(),
  stock: z.number().nonnegative().optional(),
  active: z.boolean().optional(),
});

export async function shopRoutes(app: FastifyInstance) {
  /** Live catalogue. Every row carries its unapproved alias suggestions. */
  app.get('/catalogue', async (req) => {
    const { kiranaId } = requireSession(req);

    const skus = await prisma.sku.findMany({
      where: { kiranaId },
      include: { stock: true, aliasRows: { orderBy: { approved: 'desc' } } },
      orderBy: { name: 'asc' },
    });

    return {
      skus: skus.map((s) => ({
        id: s.id,
        name: s.name,
        brand: s.brand,
        sellPaise: s.sellPaise,
        costPaise: s.costPaise,
        stock: s.stock?.quantity ?? 0,
        active: s.active,
        aliases: s.aliasRows.filter((a) => a.approved).map((a) => ({ id: a.id, alias: a.alias })),
        suggested: s.aliasRows.filter((a) => !a.approved).map((a) => ({ id: a.id, alias: a.alias })),
      })),
    };
  });

  app.patch('/catalogue/:skuId', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { skuId } = req.params as { skuId: string };
    const parsed = patchSku.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad body' });

    const sku = await prisma.sku.findFirst({ where: { id: skuId, kiranaId } });
    if (!sku) return reply.code(404).send({ error: 'no such sku' });

    if (parsed.data.sellPaise !== undefined || parsed.data.active !== undefined) {
      await prisma.sku.update({
        where: { id: skuId },
        data: {
          ...(parsed.data.sellPaise !== undefined ? { sellPaise: parsed.data.sellPaise } : {}),
          ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
        },
      });
    }
    if (parsed.data.stock !== undefined) {
      await prisma.stock.upsert({
        where: { skuId },
        create: { skuId, quantity: parsed.data.stock },
        update: { quantity: parsed.data.stock },
      });
    }

    invalidateCatalog(kiranaId);
    return { ok: true };
  });

  /** Orders with their lines, newest first. Flat list, no dashboard chrome. */
  app.get('/orders', async (req) => {
    const { kiranaId } = requireSession(req);

    const orders = await prisma.order.findMany({
      where: { kiranaId },
      include: {
        household: true,
        lines: { include: { sku: true } },
        invoice: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 60,
    });

    return {
      orders: orders.map((o) => ({
        id: o.id,
        household: o.household.name,
        status: o.status,
        source: o.source,
        totalPaise: o.totalPaise,
        createdAt: o.createdAt,
        transcript: o.transcript,
        latencyMs: o.latencyMs,
        lines: o.lines.map((l) => ({
          name: l.sku?.name ?? l.sourceText,
          quantity: l.quantity,
          linePaise: l.linePaise,
          // surfaced so the owner can see HOW it was matched, which is also
          // where the ablation numbers come from
          method: l.method,
          confidence: l.confidence,
          wasSubstituted: l.wasSubstituted,
          sourceText: l.sourceText,
        })),
        outstandingPaise: o.invoice
          ? o.invoice.amountPaise - o.invoice.amountPaidPaise
          : 0,
      })),
    };
  });

  app.get('/households', async (req) => {
    const { kiranaId } = requireSession(req);
    const rows = await prisma.household.findMany({
      where: { kiranaId },
      include: { _count: { select: { orders: true } } },
      orderBy: { name: 'asc' },
    });
    return {
      households: rows.map((h) => ({
        id: h.id, name: h.name, phone: h.phone,
        memberCount: h.memberCount, autonomyTier: h.autonomyTier,
        streak: h.streak, orders: h._count.orders,
      })),
    };
  });

  /**
   * THE COUNTER QR.
   *
   * Encodes a wa.me deep link that opens WhatsApp with the sandbox join
   * message pre-filled. A household scans it once and is connected to this
   * shop's ordering line.
   *
   * Every kirana in India already has a QR taped to the counter for UPI.
   * This is the second one, and unlike the shop-side connection it works
   * identically in production. Only the number it points at changes.
   */
  app.get('/shop/qr', async (req, reply) => {
    requireSession(req);

    const number = env.TWILIO_WHATSAPP_FROM.replace(/\D/g, '');
    const join = env.TWILIO_SANDBOX_JOIN_CODE ?? '';
    const link = `https://wa.me/${number}${join ? `?text=${encodeURIComponent(join)}` : ''}`;

    const png = await QRCode.toBuffer(link, {
      width: 640, margin: 2, errorCorrectionLevel: 'M',
    });

    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'no-store');
    return reply.send(png);
  });

  app.get('/shop/connect', async (req) => {
    const { kiranaId } = requireSession(req);
    const kirana = await prisma.kirana.findUniqueOrThrow({ where: { id: kiranaId } });

    const number = env.TWILIO_WHATSAPP_FROM.replace(/\D/g, '');
    const join = env.TWILIO_SANDBOX_JOIN_CODE ?? '';

    return {
      // customer side: live today, unchanged in production
      counterQrUrl: '/shop/qr',
      joinLink: `https://wa.me/${number}${join ? `?text=${encodeURIComponent(join)}` : ''}`,
      joinCode: join,
      sandboxNumber: env.TWILIO_WHATSAPP_FROM.replace('whatsapp:', ''),
      // shop side: Meta Coexistence, not a ten-day item
      whatsappNumber: kirana.whatsappNumber,
      wabaStatus: kirana.wabaStatus,
    };
  });
}
