import { prisma } from '@nukkad/db';
import { sendText } from '../channels/evolution.js';

/**
 * THE OTHER HALF OF THE SHOP'S WHATSAPP.
 *
 * Everything else in this system is the shop talking to a HOUSEHOLD. This
 * is the shop talking to its DISTRIBUTOR, and it is the leg that makes
 * the inventory intelligence an actual loop rather than a chart: a
 * customer asks for something the shelf cannot cover, the ledger records
 * it, the dashboard recommends it, and then somebody has to actually
 * order it. Until this file that last step was a human opening WhatsApp.
 *
 * WHAT THIS IS NOT. There is no supplier->SKU catalogue anywhere in the
 * schema and there deliberately is not one here: a kirana with two
 * distributors knows which one to call, and a wrong mapping sends an
 * order to the wrong shop. The owner picks the supplier; we compose,
 * send, and record.
 *
 * NOTHING HERE IS WRITTEN BY A MODEL. The quantities come from stock
 * arithmetic and the sentences are templates, because an ordering message
 * is a commitment to buy: a hallucinated "20 packet" is twenty packets a
 * shopkeeper actually pays for. Same rule as the payment slip.
 */

/** how many days of cover an order aims to restore */
const COVER_DAYS = 14;
/** sales window used to estimate how fast a SKU actually moves */
const VELOCITY_DAYS = 30;
/** what to order when a SKU has never sold, so velocity says nothing */
const BLIND_ORDER = 6;
/** at or below this, a SKU is a restock candidate */
export const LOW_STOCK_AT = 5;

export interface OrderLineSuggestion {
  skuId: string;
  name: string;
  /** packets on the shelf right now */
  inStock: number;
  /** packets to order */
  quantity: number;
  /** why this number, in the shopkeeper's terms -- shown in the UI */
  why: string;
}

/**
 * What is worth ordering, and how much of it.
 *
 * The quantity is arithmetic the owner can check: how fast it sold over
 * the last month, times a fortnight of cover, minus what is still on the
 * shelf. A SKU with no sales history gets a flat small order rather than
 * a confident guess, and says so.
 */
export async function suggestOrder(
  kiranaId: string,
  skuIds?: string[],
): Promise<OrderLineSuggestion[]> {
  const since = new Date(Date.now() - VELOCITY_DAYS * 86_400_000);

  const [stocks, sold] = await Promise.all([
    prisma.stock.findMany({
      where: {
        sku: { kiranaId, active: true, ...(skuIds?.length ? { id: { in: skuIds } } : {}) },
        ...(skuIds?.length ? {} : { quantity: { lte: LOW_STOCK_AT } }),
      },
      include: { sku: true },
      orderBy: { quantity: 'asc' },
    }),
    prisma.orderLine.groupBy({
      by: ['skuId'],
      where: {
        skuId: { not: null },
        order: { kiranaId, status: { not: 'CANCELLED' }, createdAt: { gte: since } },
      },
      _sum: { quantity: true },
    }),
  ]);

  const soldBySku = new Map(sold.map((r) => [r.skuId!, r._sum.quantity ?? 0]));

  return stocks.map((s) => {
    const units = soldBySku.get(s.skuId) ?? 0;
    const perDay = units / VELOCITY_DAYS;

    if (units <= 0) {
      return {
        skuId: s.skuId,
        name: s.sku.name,
        inStock: s.quantity,
        quantity: BLIND_ORDER,
        why: `${VELOCITY_DAYS} din mein koi bikri nahi -- ${BLIND_ORDER} packet trial`,
      };
    }

    const target = Math.ceil(perDay * COVER_DAYS);
    const quantity = Math.max(1, target - Math.floor(s.quantity));
    return {
      skuId: s.skuId,
      name: s.sku.name,
      inStock: s.quantity,
      quantity,
      why: `${units} bike ${VELOCITY_DAYS} din mein, ${COVER_DAYS} din ka cover`,
    };
  });
}

/**
 * The message itself. Built by string concatenation on purpose -- see the
 * note at the top of this file about who is allowed to write numbers that
 * cost money.
 */
export function composeOrder(
  shopName: string,
  supplierName: string,
  lines: OrderLineSuggestion[],
  note?: string,
): string {
  const items = lines.map((l, i) => `${i + 1}. ${l.name} -- ${l.quantity} packet`);
  return [
    `Namaste ${supplierName} ji,`,
    `${shopName} se order hai:`,
    '',
    ...items,
    '',
    note?.trim() || 'Kab tak bhej sakte hain?',
  ].join('\n');
}

export interface SentOrder {
  ok: boolean;
  supplier: string;
  phone: string;
  text: string;
  lines: OrderLineSuggestion[];
  error?: string;
}

/**
 * Send it, and record it whether or not it left.
 *
 * The Message row is written in both cases: a supplier order that failed
 * to send is exactly the thing a shopkeeper needs to see, and a thread
 * that silently drops its failures is worse than no thread. Conversation
 * carries partyRole SUPPLIER, which is what keeps this out of the
 * household views -- and out of the desks, see routes/evolution.ts.
 */
export async function sendSupplierOrder(args: {
  kiranaId: string;
  supplierId: string;
  lines: OrderLineSuggestion[];
  note?: string;
}): Promise<SentOrder> {
  const [supplier, kirana] = await Promise.all([
    prisma.supplier.findFirst({ where: { id: args.supplierId, kiranaId: args.kiranaId } }),
    prisma.kirana.findUnique({ where: { id: args.kiranaId } }),
  ]);

  if (!supplier) throw new Error('supplier not found');
  if (!args.lines.length) throw new Error('nothing to order');

  const text = composeOrder(
    kirana?.name ?? 'Nukkad',
    supplier.name,
    args.lines,
    args.note,
  );

  const res = await sendText(supplier.phone, text);

  const conversation = await prisma.conversation.upsert({
    where: { channel_peerPhone: { channel: 'evolution', peerPhone: supplier.phone } },
    create: {
      channel: 'evolution',
      peerPhone: supplier.phone,
      partyRole: 'SUPPLIER',
      kiranaId: args.kiranaId,
    },
    update: { kiranaId: args.kiranaId, partyRole: 'SUPPLIER' },
  });

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'OUT',
      externalId: res.externalId ?? null,
      body: res.ok ? text : `[not delivered: ${res.error}]\n${text}`,
      intent: 'REQUEST',
      goal: 'RESTOCKING',
    },
  });

  return {
    ok: res.ok,
    supplier: supplier.name,
    phone: supplier.phone,
    text,
    lines: args.lines,
    error: res.error,
  };
}

/** Is this number one of our suppliers? Used to keep replies out of the desks. */
export const supplierByPhone = (phone: string) =>
  prisma.supplier.findFirst({ where: { phone, active: true }, include: { kirana: true } });
