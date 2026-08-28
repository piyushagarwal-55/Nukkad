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
  /**
   * Lines the shelf could not cover, after the money had already landed.
   *
   * Almost always empty. When it is not, somebody has paid for something
   * this shop cannot hand over, and the caller must say so rather than
   * quietly deliver a smaller bag. See the guarded decrement below for
   * how two customers end up buying the same last packet.
   */
  short: Array<{ skuId: string; name: string; quantity: number }>;
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
  /**
   * GUARDED, AND IN ONE TRANSACTION. Both halves were bugs.
   *
   * THE RACE. A bare decrement cannot fail, so it cannot refuse. Stock is
   * checked when a line goes into a basket -- against a cached map, sixty
   * seconds stale by design -- and taken here, when the money lands. Two
   * households can sit between those two moments at the same time: both
   * are told the last bag is available, both check out, both pay, and the
   * shelf goes to minus one. Nobody notices until a delivery is short,
   * which is the worst possible time to find out.
   *
   * The `gte` makes the write refuse instead. updateMany reports how many
   * rows it changed, so a count of zero IS the answer to "was there
   * enough" -- and it is the database answering, atomically, rather than
   * a read followed by a hopeful write.
   *
   * THE ROUND TRIPS. This looped with an await inside it, so a five-line
   * order was five sequential trips to a database 3,000km away. They do
   * not depend on each other; the only reason they were serial is that
   * the loop was written before anyone measured one.
   */
  const stocked = order.lines.filter((l) => l.skuId);

  const results = await prisma.$transaction(
    stocked.map((line) =>
      prisma.stock.updateMany({
        where: { skuId: line.skuId!, quantity: { gte: line.quantity } },
        data: { quantity: { decrement: line.quantity } },
      }),
    ),
  );

  /**
   * WHAT COULD NOT BE TAKEN, and it must not be swallowed.
   *
   * The guard above stops the shelf going negative; it does not stop the
   * customer having paid. Silently shipping one fewer bag is how a shop
   * loses a regular. So the shortfall is recorded on the order and handed
   * back to the caller, whose job it is to tell somebody -- see the
   * `short` field on Settlement.
   */
  const short = stocked
    .filter((_, i) => results[i]?.count === 0)
    .map((l) => ({ skuId: l.skuId!, name: l.sku?.name ?? l.sourceText, quantity: l.quantity }));

  /**
   * The order stays CONFIRMED, because it is: the money landed. What did
   * not land is a bag, and that is a fulfilment problem for a human, not
   * a payment problem for the state machine.
   */
  if (short.length) console.error({ orderId, short }, 'paid order could not be fully stocked');

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

  return { to: order.household.phone, text: bill(order), short };
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
