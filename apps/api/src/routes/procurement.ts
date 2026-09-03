import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PurchaseStatus } from '@prisma/client';
import { prisma } from '@nukkad/db';
import { requireSession } from './auth.js';
import { draftPurchaseOrder } from '../services/procurement/plan.js';
import { sendToSupplier } from '../services/procurement/owner.js';

const OPEN_STATUSES: PurchaseStatus[] = ['DRAFT', 'AWAITING_OWNER', 'SENT'];

const lineSchema = z.object({
  id: z.string().optional(),
  skuId: z.string().nullable().optional(),
  name: z.string().min(1),
  quantity: z.coerce.number().positive(),
  why: z.string().nullable().optional(),
  inStock: z.coerce.number().default(0),
  costPaise: z.coerce.number().int().nullable().optional(),
});

const updateSchema = z.object({
  supplierId: z.string().nullable().optional(),
  lines: z.array(lineSchema).min(1),
});

async function hydrate(kiranaId: string, orderId?: string) {
  const order = orderId
    ? await prisma.purchaseOrder.findFirst({
        where: { id: orderId, kiranaId },
        include: { lines: { orderBy: { id: 'asc' } } },
      })
    : await prisma.purchaseOrder.findFirst({
        where: { kiranaId, status: { in: OPEN_STATUSES } },
        include: { lines: { orderBy: { id: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      }) ?? await prisma.purchaseOrder.findFirst({
        where: { kiranaId },
        include: { lines: { orderBy: { id: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      });

  const [suppliers, kirana] = await Promise.all([
    prisma.supplier.findMany({
      where: { kiranaId, active: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.kirana.findUnique({ where: { id: kiranaId } }),
  ]);

  const supplier = order?.supplierId
    ? suppliers.find((s) => s.id === order.supplierId) ?? null
    : suppliers[0] ?? null;

  return { kirana, suppliers, supplier, order };
}

export async function procurementRoutes(app: FastifyInstance) {
  app.get('/procurement', async (req) => {
    const { kiranaId } = requireSession(req);
    return hydrate(kiranaId);
  });

  app.post('/procurement/draft', async (req, reply) => {
    const { kiranaId } = requireSession(req);

    const existing = await prisma.purchaseOrder.findFirst({
      where: { kiranaId, status: { in: OPEN_STATUSES } },
      include: { lines: { orderBy: { id: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return hydrate(kiranaId, existing.id);

    const order = await draftPurchaseOrder(kiranaId);
    if (!order) return reply.code(400).send({ error: 'nothing worth ordering right now' });

    await prisma.purchaseOrder.update({
      where: { id: order.id },
      data: { status: 'AWAITING_OWNER', askedAt: new Date() },
    });
    return hydrate(kiranaId, order.id);
  });

  app.patch('/procurement/:id', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { id } = req.params as { id: string };
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const order = await prisma.purchaseOrder.findFirst({
      where: { id, kiranaId },
      include: { lines: true },
    });
    if (!order) return reply.code(404).send({ error: 'order not found' });
    if (!['DRAFT', 'AWAITING_OWNER'].includes(order.status)) {
      return reply.code(400).send({ error: `cannot edit a ${order.status.toLowerCase()} order` });
    }

    if (parsed.data.supplierId) {
      const supplier = await prisma.supplier.findFirst({
        where: { id: parsed.data.supplierId, kiranaId, active: true },
      });
      if (!supplier) return reply.code(400).send({ error: 'supplier not found' });
    }

    const incomingIds = new Set(parsed.data.lines.map((l) => l.id).filter(Boolean));
    const deleteIds = order.lines.map((l) => l.id).filter((lineId) => !incomingIds.has(lineId));

    await prisma.$transaction(async (tx) => {
      if (deleteIds.length) {
        await tx.purchaseOrderLine.deleteMany({ where: { id: { in: deleteIds }, orderId: id } });
      }

      await tx.purchaseOrder.update({
        where: { id },
        data: {
          supplierId: parsed.data.supplierId ?? null,
          status: 'AWAITING_OWNER',
          ownerLog: [
            ...(Array.isArray(order.ownerLog) ? order.ownerLog : []),
            { at: new Date().toISOString(), action: 'dashboard_edit' },
          ] as never,
        },
      });

      for (const line of parsed.data.lines) {
        const data = {
          skuId: line.skuId ?? null,
          name: line.name.trim(),
          quantity: line.quantity,
          why: line.why?.trim() || 'owner edited in dashboard',
          inStock: line.inStock,
          costPaise: line.costPaise ?? null,
        };

        if (line.id) {
          await tx.purchaseOrderLine.updateMany({
            where: { id: line.id, orderId: id },
            data,
          });
        } else {
          await tx.purchaseOrderLine.create({ data: { orderId: id, ...data } });
        }
      }
    });

    return hydrate(kiranaId, id);
  });

  app.delete('/procurement/:id/lines/:lineId', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { id, lineId } = req.params as { id: string; lineId: string };
    const order = await prisma.purchaseOrder.findFirst({ where: { id, kiranaId } });
    if (!order) return reply.code(404).send({ error: 'order not found' });
    if (!['DRAFT', 'AWAITING_OWNER'].includes(order.status)) {
      return reply.code(400).send({ error: `cannot edit a ${order.status.toLowerCase()} order` });
    }
    await prisma.purchaseOrderLine.deleteMany({ where: { id: lineId, orderId: id } });
    const left = await prisma.purchaseOrderLine.count({ where: { orderId: id } });
    if (!left) await prisma.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' } });
    return hydrate(kiranaId, id);
  });

  app.post('/procurement/:id/send', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { id } = req.params as { id: string };
    const order = await prisma.purchaseOrder.findFirst({ where: { id, kiranaId }, include: { lines: true } });
    if (!order) return reply.code(404).send({ error: 'order not found' });
    if (!['DRAFT', 'AWAITING_OWNER'].includes(order.status)) {
      return reply.code(400).send({ error: `cannot send a ${order.status.toLowerCase()} order` });
    }
    if (!order.lines.length) return reply.code(400).send({ error: 'order has no lines' });

    const result = await sendToSupplier(kiranaId, id);
    const fresh = await hydrate(kiranaId, id);
    return { ...fresh, result };
  });
}
