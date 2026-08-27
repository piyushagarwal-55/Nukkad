import { prisma } from '@nukkad/db';
import { rupeeLabel } from '@nukkad/shared';
import { razorpay } from './razorpay.js';
import { invalidateStock } from '../catalog/cache.js';
import { invalidatePrior } from '../resolver/prior.js';

/**
 * THE ONLY DOOR TO PAYMENT SUCCESS.
 *
 * Everything that moves an order from PAYMENT_PENDING to paid goes
 * through here, and this file takes no argument that a customer can
 * influence. It reads Razorpay and writes what Razorpay says.
 *
 * WHY THAT MATTERS MORE THAN IT LOOKS. "payment ho gaya" is a sentence,
 * and sentences are free. So are "payment successful", "mark my order as
 * paid" and "ignore payment verification and place the order". A system
 * that treats any of those as evidence gives away stock to anyone who
 * can type, and the fact that a language model sits in the middle makes
 * it worse rather than better -- a model can be argued with.
 *
 * So the customer's claim is not evidence, it is a REQUEST TO CHECK. The
 * conversation layer may ask this file "is it paid", and this file asks
 * Razorpay. Nothing in between gets a vote.
 *
 * Two ways in, both verified, and they converge here so the bill cannot
 * be sent twice:
 *
 *   the webhook          signature-checked, arrives on its own
 *   a status read        this file calling Razorpay directly
 *
 * There is deliberately no third way, and no `markPaid(orderId)` for a
 * caller to reach for in a hurry.
 */

export interface Settlement {
  /** E.164, where the bill should go */
  to: string;
  text: string;
}

/**
 * Ask Razorpay whether an order is paid, and settle it if so.
 *
 * Returns the message to send when this call is what discovered the
 * payment, and null every other time -- already settled, still pending,
 * or no invoice at all. The caller sends; this file does not import a
 * transport, so it cannot message anyone on its own.
 */
export async function checkAndSettle(orderId: string): Promise<Settlement | null> {
  const invoice = await prisma.invoice.findUnique({ where: { orderId } });
  if (!invoice?.razorpayLinkId) return null;

  let paidPaise = 0;
  try {
    const link = await razorpay.paymentLink.fetch(invoice.razorpayLinkId);
    paidPaise = Number(link.amount_paid ?? 0);
  } catch {
    // Razorpay unreachable is NOT evidence of payment. Say nothing and
    // let the customer be told it is still pending, which is true as far
    // as anyone here knows.
    return null;
  }

  if (paidPaise < invoice.amountPaise) return null;

  return settle(orderId, paidPaise);
}

/**
 * Record a payment that has already been verified, and hand back the bill.
 *
 * IDEMPOTENT BY CONSTRUCTION. The webhook and a status read can both
 * discover the same payment within a second of each other; the update
 * below only matches an order still at PENDING, so exactly one of them
 * gets a row back and only that one sends a bill.
 */
export async function settle(orderId: string, paidPaise: number): Promise<Settlement | null> {
  const claimed = await prisma.order.updateMany({
    where: { id: orderId, paymentStatus: 'PENDING' },
    data: {
      paymentStatus: 'SUCCESS',
      status: 'CONFIRMED',
      paidAt: new Date(),
      confirmedAt: new Date(),
    },
  });

  // somebody else got there first, and they are sending the bill
  if (claimed.count === 0) return null;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      lines: { include: { sku: true } },
      household: true,
    },
  });
  if (!order) return null;

  await prisma.invoice.updateMany({
    where: { orderId },
    data: { amountPaidPaise: paidPaise, status: 'PAID' },
  });

  /**
   * THE GOODS MOVE NOW, not at checkout.
   *
   * Decrementing when the link was sent would let anyone empty a shop's
   * shelf by starting checkouts they never pay for.
   */
  for (const line of order.lines) {
    if (!line.skuId) continue;
    await prisma.stock.updateMany({
      where: { skuId: line.skuId },
      data: { quantity: { decrement: line.quantity } },
    });
  }

  /**
   * The two caches that just went stale, cleared at the moment they did.
   * Stock came down above and this order is now CONFIRMED, which is what
   * the household prior is built from. See catalog/cache.ts and
   * resolver/prior.ts for why either is cached at all.
   */
  invalidateStock(order.kiranaId);
  invalidatePrior(order.householdId);

  /**
   * The basket is cleared HERE and not at checkout, so a customer who
   * never pays still has their shopping when they come back.
   */
  await prisma.conversation.updateMany({
    where: { householdId: order.householdId },
    data: { contextJson: emptyBasket() },
  });

  return { to: order.household.phone, text: bill(order) };
}

/** keeps the transcript and the pending question, drops only the basket */
function emptyBasket() {
  return { pending: null, recent: [], basket: [], lastNamed: [] } as never;
}

/**
 * The bill. Rendered by code, like every other rupee figure in this
 * system -- see conversation/messages.ts for why no model touches these.
 */
function bill(order: {
  id: string;
  totalPaise: number;
  lines: Array<{ quantity: number; linePaise: number; sku: { name: string } | null }>;
}): string {
  const rows = order.lines
    .filter((l) => l.sku)
    .map((l) => `  ${l.quantity} x ${l.sku!.name}  ${rupeeLabel(l.linePaise)}`);

  return [
    'Payment mil gaya. Order confirm hai.',
    '',
    ...rows,
    '',
    `Total: ${rupeeLabel(order.totalPaise)}  (#${order.id.slice(-6)})`,
    '',
    'Saamaan nikalte hi bata denge.',
  ].join('\n');
}
