import type { FastifyInstance } from 'fastify';
import { prisma } from '@nukkad/db';
import { requireSession } from './auth.js';
import { toE164 } from '../lib/phone.js';
import {
  suggestOrder, sendSupplierOrder, composeOrder, LOW_STOCK_AT,
} from '../services/suppliers/order.js';
import { evolutionReady } from '../services/channels/evolution.js';

/**
 * THE SUPPLIER DESK OF THE DASHBOARD.
 *
 * Read-only until the owner presses send: /suggest shows exactly what
 * would go out and why each number was chosen, /order sends it. The
 * preview is not a courtesy -- an ordering message is a commitment to
 * buy, so nothing leaves this system without a human having seen the
 * literal text first.
 */
export async function supplierRoutes(app: FastifyInstance) {
  app.get('/suppliers', async (req) => {
    const { kiranaId } = requireSession(req);
    const suppliers = await prisma.supplier.findMany({
      where: { kiranaId, active: true },
      orderBy: { createdAt: 'asc' },
    });
    return { suppliers, transportReady: evolutionReady() };
  });

  app.post('/suppliers', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { name, phone } = (req.body ?? {}) as { name?: string; phone?: string };
    if (!name?.trim() || !phone?.trim()) {
      return reply.code(400).send({ error: 'name and phone required' });
    }

    const e164 = toE164(phone.trim());
    return prisma.supplier.upsert({
      where: { kiranaId_phone: { kiranaId, phone: e164 } },
      create: { kiranaId, name: name.trim(), phone: e164 },
      update: { name: name.trim(), active: true },
    });
  });

  app.delete('/suppliers/:id', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { id } = req.params as { id: string };
    // deactivated rather than deleted: the message thread stays readable
    const done = await prisma.supplier.updateMany({
      where: { id, kiranaId },
      data: { active: false },
    });
    if (!done.count) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  /**
   * What would be ordered, and the exact words. Nothing is sent here.
   */
  app.get('/suppliers/suggest', async (req) => {
    const { kiranaId } = requireSession(req);
    const { supplierId, skuIds } = req.query as { supplierId?: string; skuIds?: string };

    const lines = await suggestOrder(
      kiranaId,
      skuIds ? skuIds.split(',').filter(Boolean) : undefined,
    );

    const [supplier, kirana] = await Promise.all([
      supplierId
        ? prisma.supplier.findFirst({ where: { id: supplierId, kiranaId } })
        : prisma.supplier.findFirst({ where: { kiranaId, active: true }, orderBy: { createdAt: 'asc' } }),
      prisma.kirana.findUnique({ where: { id: kiranaId } }),
    ]);

    return {
      lowStockAt: LOW_STOCK_AT,
      lines,
      supplier,
      preview: supplier && lines.length
        ? composeOrder(kirana?.name ?? 'Nukkad', supplier.name, lines)
        : null,
    };
  });

  app.post('/suppliers/order', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { supplierId, skuIds, note } = (req.body ?? {}) as {
      supplierId?: string; skuIds?: string[]; note?: string;
    };
    if (!supplierId) return reply.code(400).send({ error: 'supplierId required' });

    const lines = await suggestOrder(kiranaId, skuIds);
    if (!lines.length) return reply.code(400).send({ error: 'nothing is low on stock' });

    try {
      return await sendSupplierOrder({ kiranaId, supplierId, lines, note });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * The thread, both directions. This is the surface that proves the shop
   * messaged its distributor by itself -- and it is OUR record, not a
   * screenshot of somebody's phone.
   */
  app.get('/suppliers/thread', async (req) => {
    const { kiranaId } = requireSession(req);
    const { supplierId } = req.query as { supplierId?: string };

    const suppliers = await prisma.supplier.findMany({ where: { kiranaId } });
    const phones = supplierId
      ? suppliers.filter((s) => s.id === supplierId).map((s) => s.phone)
      : suppliers.map((s) => s.phone);
    if (!phones.length) return { messages: [] };

    const conversations = await prisma.conversation.findMany({
      where: { channel: 'evolution', peerPhone: { in: phones }, partyRole: 'SUPPLIER' },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 40 } },
    });

    const byPhone = new Map(suppliers.map((s) => [s.phone, s.name]));
    const messages = conversations
      .flatMap((c) => c.messages.map((m) => ({
        id: m.id,
        supplier: byPhone.get(c.peerPhone) ?? c.peerPhone,
        phone: c.peerPhone,
        direction: m.direction,
        body: m.body ?? '',
        createdAt: m.createdAt,
      })))
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, 40);

    return { messages };
  });
}
