import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { prisma } from '@nukkad/db';
import { env } from '../config/env.js';
import { requireSession } from './auth.js';
import { toE164, maskPhone } from '../lib/phone.js';
import { invalidateCatalog } from '../services/catalog/cache.js';
import { syncAliasArray } from '../services/catalog/aliases.js';

const newHousehold = z.object({
  name: z.string().min(2),
  phone: z.string().min(10),
  memberCount: z.number().int().min(1).max(30).optional(),
});

const patchSku = z.object({
  name: z.string().min(1).max(120).optional(),
  brand: z.string().max(80).nullable().optional(),
  packSize: z.number().positive().optional(),
  unit: z.string().min(1).max(12).optional(),
  category: z.string().max(60).nullable().optional(),
  sellPaise: z.number().int().nonnegative().optional(),
  costPaise: z.number().int().nonnegative().nullable().optional(),
  stock: z.number().nonnegative().optional(),
  active: z.boolean().optional(),
});

const newSku = z.object({
  name: z.string().min(1).max(120),
  brand: z.string().max(80).optional(),
  packSize: z.number().positive().default(1),
  unit: z.string().min(1).max(12).default('pc'),
  category: z.string().max(60).optional(),
  sellPaise: z.number().int().nonnegative(),
  costPaise: z.number().int().nonnegative().optional(),
  stock: z.number().nonnegative().default(0),
  aliases: z.array(z.string().min(1).max(60)).max(12).default([]),
});

export async function shopRoutes(app: FastifyInstance) {
  /** Live catalogue. Every row carries its unapproved alias suggestions. */
  app.get('/catalogue', async (req) => {
    const { kiranaId } = requireSession(req);

    const skus = await prisma.sku.findMany({
      where: { kiranaId },
      include: {
        stock: true,
        aliasRows: { orderBy: { approved: 'desc' } },
        _count: { select: { orderLines: true } },
      },
      orderBy: { name: 'asc' },
    });

    return {
      skus: skus.map((s) => ({
        id: s.id,
        name: s.name,
        brand: s.brand,
        packSize: s.packSize,
        unit: s.unit,
        category: s.category,
        sellPaise: s.sellPaise,
        costPaise: s.costPaise,
        stock: s.stock?.quantity ?? 0,
        active: s.active,
        // how many order lines point at this SKU, so the dashboard can warn
        // that deleting it detaches real history
        orderCount: s._count.orderLines,
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

    /**
     * Build the update from whichever keys were actually sent.
     *
     * Spreading each field conditionally rather than passing parsed.data
     * wholesale matters twice over: `stock` is not a column on Sku and
     * would throw, and an absent key must mean "leave it alone" while an
     * explicit null must mean "clear it". Those are different, and brand
     * and costPaise are both nullable, so collapsing them would wipe a
     * cost price every time somebody edited a name.
     */
    const d = parsed.data;
    const fields = {
      ...(d.name !== undefined ? { name: d.name.trim() } : {}),
      ...(d.brand !== undefined ? { brand: d.brand } : {}),
      ...(d.packSize !== undefined ? { packSize: d.packSize } : {}),
      ...(d.unit !== undefined ? { unit: d.unit } : {}),
      ...(d.category !== undefined ? { category: d.category } : {}),
      ...(d.sellPaise !== undefined ? { sellPaise: d.sellPaise } : {}),
      ...(d.costPaise !== undefined ? { costPaise: d.costPaise } : {}),
      ...(d.active !== undefined ? { active: d.active } : {}),
    };

    if (Object.keys(fields).length > 0) {
      // a rename must not collide with another item in the same shop
      if (d.name !== undefined) {
        const clash = await prisma.sku.findFirst({
          where: {
            kiranaId,
            name: { equals: d.name.trim(), mode: 'insensitive' },
            id: { not: skuId },
          },
        });
        if (clash) {
          return reply.code(409).send({ error: `${d.name.trim()} is already in the catalogue.` });
        }
      }
      await prisma.sku.update({ where: { id: skuId }, data: fields });
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

  /**
   * Add one item by hand.
   *
   * The bill upload is the fast path and stays the fast path, but a shop
   * always has the handful of things no supplier bill ever covers: loose
   * items, a local brand, something bought cash from the mandi.
   */
  app.post('/catalogue', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const parsed = newSku.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'bad body' });
    }
    const d = parsed.data;

    const clash = await prisma.sku.findFirst({
      where: { kiranaId, name: { equals: d.name, mode: 'insensitive' } },
    });
    if (clash) return reply.code(409).send({ error: `${d.name} is already in the catalogue.` });

    const sku = await prisma.sku.create({
      data: {
        kiranaId,
        name: d.name,
        brand: d.brand ?? null,
        packSize: d.packSize,
        unit: d.unit,
        category: d.category ?? null,
        sellPaise: d.sellPaise,
        costPaise: d.costPaise ?? null,
        // hand-added names are approved by definition: the owner typed them
        aliases: d.aliases,
        stock: { create: { quantity: d.stock } },
        aliasRows: {
          create: d.aliases.map((alias) => ({
            alias,
            source: 'OWNER' as const,
            approved: true,
          })),
        },
      },
    });

    invalidateCatalog(kiranaId);
    return { ok: true, id: sku.id };
  });

  /**
   * Remove an item.
   *
   * Order lines keep their own text and price and their skuId simply goes
   * null, so history survives a delete. Burn rates cascade away with it,
   * which is right: they are derived from a product that no longer exists.
   */
  app.delete('/catalogue/:skuId', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { skuId } = req.params as { skuId: string };

    const sku = await prisma.sku.findFirst({ where: { id: skuId, kiranaId } });
    if (!sku) return reply.code(404).send({ error: 'no such item' });

    await prisma.sku.delete({ where: { id: skuId } });
    invalidateCatalog(kiranaId);
    return { ok: true };
  });

  /** Add a local name by hand. Approved on arrival, because the owner typed it. */
  app.post('/catalogue/:skuId/aliases', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { skuId } = req.params as { skuId: string };
    const parsed = z.object({ alias: z.string().min(1).max(60) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'alias required' });

    const sku = await prisma.sku.findFirst({ where: { id: skuId, kiranaId } });
    if (!sku) return reply.code(404).send({ error: 'no such item' });

    const alias = parsed.data.alias.trim().toLowerCase();
    const existing = await prisma.skuAlias.findUnique({
      where: { skuId_alias: { skuId, alias } },
    });
    if (existing) {
      // already suggested by the parser, so approving it is the same thing
      await prisma.skuAlias.update({ where: { id: existing.id }, data: { approved: true } });
    } else {
      await prisma.skuAlias.create({
        data: { skuId, alias, source: 'OWNER', approved: true },
      });
    }

    await syncAliasArray(skuId);
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

  /**
   * One order, with everything needed to explain it.
   *
   * The list view answers "what happened". This answers "why, and was it
   * any good": how each line was matched and how sure of it, what the shop
   * actually made on it, and how this order compares with the same
   * household's usual. A resolver that cannot be audited per order is one
   * nobody should let write a price.
   */
  app.get('/orders/:orderId', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { orderId } = req.params as { orderId: string };

    const order = await prisma.order.findFirst({
      where: { id: orderId, kiranaId },
      include: {
        household: true,
        lines: { include: { sku: true }, orderBy: { id: 'asc' } },
        invoice: { include: { payments: { orderBy: { capturedAt: 'asc' } } } },
      },
    });
    if (!order) return reply.code(404).send({ error: 'no such order' });

    // what the same household usually does, for context on this one
    const siblings = await prisma.order.findMany({
      where: { householdId: order.householdId, status: { not: 'CANCELLED' } },
      select: { id: true, totalPaise: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const others = siblings.filter((o) => o.id !== order.id);
    const avgPaise = others.length
      ? Math.round(others.reduce((a, b) => a + b.totalPaise, 0) / others.length)
      : null;
    const previous = others.find((o) => o.createdAt < order.createdAt) ?? null;

    /**
     * Substituted names come from the SKU that was originally asked for.
     * Fetched in one query rather than per line, because a ten line order
     * would otherwise be ten more round trips to Seoul.
     */
    const fromIds = order.lines
      .map((l) => l.substitutedFromSkuId)
      .filter((x): x is string => !!x);
    const fromSkus = fromIds.length
      ? await prisma.sku.findMany({ where: { id: { in: fromIds } }, select: { id: true, name: true } })
      : [];
    const fromById = new Map(fromSkus.map((s) => [s.id, s.name]));

    const lines = order.lines.map((l) => {
      // Margin is only knowable where the SKU carries a cost basis, which
      // it does once a supplier bill has been through it. Null is honest
      // where a flat markup guess would not be.
      const cost = l.sku?.costPaise ?? null;
      const costTotal = cost === null ? null : Math.round(cost * l.quantity);
      return {
        id: l.id,
        name: l.sku?.name ?? l.sourceText,
        skuId: l.skuId,
        sourceText: l.sourceText,
        quantity: l.quantity,
        unitHint: l.unitHint,
        unitPricePaise: l.unitPricePaise,
        linePaise: l.linePaise,
        costPaise: costTotal,
        marginPaise: costTotal === null ? null : l.linePaise - costTotal,
        method: l.method,
        confidence: l.confidence,
        wasSubstituted: l.wasSubstituted,
        substitutedFrom: l.substitutedFromSkuId ? fromById.get(l.substitutedFromSkuId) ?? null : null,
        alternates: l.alternatesJson,
      };
    });

    const known = lines.filter((l) => l.costPaise !== null);
    const costTotal = known.reduce((a, b) => a + (b.costPaise ?? 0), 0);
    const revenueOfKnown = known.reduce((a, b) => a + b.linePaise, 0);

    return {
      id: order.id,
      status: order.status,
      source: order.source,
      totalPaise: order.totalPaise,
      createdAt: order.createdAt,
      confirmedAt: order.confirmedAt,
      cancelledAt: order.cancelledAt,
      transcript: order.transcript,
      rawText: order.rawText,
      asrEngine: order.asrEngine,
      latencyMs: order.latencyMs,

      household: {
        id: order.household.id,
        name: order.household.name,
        phone: order.household.phone,
        memberCount: order.household.memberCount,
        autonomyTier: order.household.autonomyTier,
        streak: order.household.streak,
        orderCount: siblings.length,
        avgPaise,
        previousAt: previous?.createdAt ?? null,
      },

      lines,

      margin: {
        // only over the lines whose cost is actually known, and the count
        // is returned so the screen can say so rather than imply the rest
        knownLines: known.length,
        totalLines: lines.length,
        costPaise: costTotal,
        revenuePaise: revenueOfKnown,
        marginPaise: revenueOfKnown - costTotal,
      },

      invoice: order.invoice
        ? {
            status: order.invoice.status,
            amountPaise: order.invoice.amountPaise,
            amountPaidPaise: order.invoice.amountPaidPaise,
            shortUrl: order.invoice.razorpayShortUrl,
            acceptPartial: order.invoice.acceptPartial,
            payments: order.invoice.payments.map((p) => ({
              amountPaise: p.amountPaise,
              method: p.method,
              status: p.status,
              at: p.capturedAt,
            })),
          }
        : null,
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

    /**
     * IS THE LINE ACTUALLY LIVE?
     *
     * Three things have to be true before a message gets answered, and
     * every one of them fails silently. No tunnel and Twilio cannot reach
     * the webhook at all. No customer and inbound routing resolves nobody,
     * so the shop says nothing. No catalogue and there is nothing to match
     * a spoken order against.
     *
     * A shop owner cannot debug any of that from the outside -- the symptom
     * is identical in all three cases, which is silence -- so the page says
     * which one is missing instead of leaving them to guess.
     */
    const [households, skus] = await Promise.all([
      prisma.household.count({ where: { kiranaId } }),
      prisma.sku.count({ where: { kiranaId, active: true } }),
    ]);

    const checks = [
      {
        key: 'tunnel',
        ok: !!env.PUBLIC_BASE_URL,
        label: 'WhatsApp can reach this shop',
        detail: env.PUBLIC_BASE_URL
          ? `messages arrive at ${env.PUBLIC_BASE_URL}/wa/twilio`
          : 'No public address is set, so nothing sent on WhatsApp reaches the shop at all.',
      },
      {
        key: 'customers',
        ok: households > 0,
        label: households === 1 ? '1 customer registered' : `${households} customers registered`,
        detail: households
          ? 'A message is only answered if the sender is one of them.'
          : 'Until a customer is added, every message goes unanswered.',
      },
      {
        key: 'catalogue',
        ok: skus > 0,
        label: `${skus} items to order from`,
        detail: skus
          ? 'Spoken orders are matched against these.'
          : 'With nothing in the catalogue there is nothing an order can resolve to.',
      },
    ];

    return {
      live: checks.every((c) => c.ok),
      checks,
      counts: { households, skus },
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
