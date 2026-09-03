import { prisma } from '@nukkad/db';

/**
 * PAYING THE DISTRIBUTOR -- the seam, deliberately not connected.
 *
 * The plan is UPI Reserve Pay: the shop pre-authorises a mandate, the
 * agent debits against it when a bill it has already reconciled arrives,
 * and the owner never types a UPI PIN at 11pm. That needs Razorpay
 * approval, which has not happened yet.
 *
 * WHY THIS FILE EXISTS ANYWAY, rather than a TODO in a doc. Two reasons,
 * and the second is the important one.
 *
 * First, it names the shape the rest of the system must satisfy before
 * money can move: an order that was approved by a human, a bill that was
 * read and reconciled against it, and a total under a mandate cap. Those
 * preconditions are checkable today and are checked below, so the day
 * the API arrives the change is one function body and not an
 * architecture.
 *
 * Second, and this is the whole point: it makes the refusal EXPLICIT.
 * Every other payment path in this codebase obeys one rule -- money moves
 * only from a verified fact, never from a sentence. An unbuilt payment
 * path that quietly no-ops is a place where someone later writes "mark it
 * paid" because nothing stopped them. So the function exists, it refuses
 * out loud, and PurchaseStatus.PAID has exactly one writer: a settlement
 * that a payment provider confirmed.
 */

export interface PayDecision {
  /** could this be paid automatically, if the rail existed? */
  eligible: boolean;
  /** why not, in plain words -- shown to the owner */
  reason: string;
  amountPaise: number | null;
}

/**
 * A ceiling on what an agent may ever debit without a fresh human yes.
 * Mandates have caps for the same reason autonomy tiers do: an automated
 * decision should be bounded by an amount somebody chose while calm.
 */
export const MANDATE_CAP_PAISE = 5_000_00;

/**
 * Everything that must be true before a rupee could move. Runs today,
 * against real rows, so the gap between "built" and "connected" is
 * visible rather than assumed.
 */
export async function assessAutoPay(orderId: string): Promise<PayDecision> {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { lines: true },
  });

  if (!order) return { eligible: false, reason: 'order nahi mila', amountPaise: null };
  if (order.status !== 'BILLED') {
    return { eligible: false, reason: 'bill abhi aaya nahi', amountPaise: order.amountPaise };
  }
  if (!order.approvedAt) {
    return { eligible: false, reason: 'owner ne approve nahi kiya tha', amountPaise: order.amountPaise };
  }
  if (order.amountPaise == null) {
    return { eligible: false, reason: 'bill par total nahi tha', amountPaise: null };
  }
  if (order.amountPaise > MANDATE_CAP_PAISE) {
    return {
      eligible: false,
      reason: `amount mandate cap se zyada hai`,
      amountPaise: order.amountPaise,
    };
  }
  return { eligible: true, reason: 'sab theek hai', amountPaise: order.amountPaise };
}

/**
 * The call that will one day debit the mandate.
 *
 * It refuses, and it refuses by throwing rather than returning a falsy
 * value, so no caller can mistake "not built" for "declined by the bank"
 * or -- far worse -- for success.
 */
export async function payWithReservePay(orderId: string): Promise<never> {
  const decision = await assessAutoPay(orderId);
  throw new Error(
    `UPI Reserve Pay is not connected yet (Razorpay approval pending). `
    + `Order ${orderId} would${decision.eligible ? '' : ' NOT'} qualify: ${decision.reason}.`,
  );
}
