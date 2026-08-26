import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { prisma } from '@nukkad/db';
import { env } from '../config/env.js';
import { requireSession } from './auth.js';
import { toE164, maskPhone } from '../lib/phone.js';
import { invalidateCatalog } from '../services/catalog/cache.js';

const newHousehold = z.object({
  name: z.string().min(2),
  phone: z.string().min(10),
  memberCount: z.number().int().min(1).max(30).optional(),
});

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
   * Register a customer against THIS shop.
   *
   * Without this there is no way to create a household outside the seed
   * script, which means a shop that signs up through the web form can
   * never receive a message: conversation/core.ts resolves the household
   * by (kiranaId, phone) and bails when it finds nothing.
   *
   * The number is normalised through toE164 on the way in, because that is
   * exactly what the Twilio adapter does to the inbound `From` field. If
   * these two disagree by so much as a `whatsapp:` prefix the lookup misses
   * and the shop sits there silently.
   */
  app.post('/households', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const parsed = newHousehold.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    }

    const phone = toE164(parsed.data.phone);

    // scoped to this shop, so the same customer can belong to two kiranas
    const clash = await prisma.household.findUnique({
      where: { kiranaId_phone: { kiranaId, phone } },
    });
    if (clash) {
      return reply.code(409).send({ error: 'That number is already a customer here.' });
    }

    const hh = await prisma.household.create({
      data: {
        kiranaId,
        name: parsed.data.name,
        phone,
        memberCount: parsed.data.memberCount ?? 4,
      },
    });

    app.log.info({ kiranaId, phone: maskPhone(phone) }, 'household added');
    return { ok: true, id: hh.id, name: hh.name, phone: hh.phone };
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
