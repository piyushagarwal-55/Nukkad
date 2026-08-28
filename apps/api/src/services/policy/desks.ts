/**
 * THE DESKS. One shop, one memory, different people at the counter.
 *
 * What was wrong was never the agent's intelligence. One agent held every
 * action and was asked, on every message, to pick correctly from all of
 * them. Handed "Hello" plus a transcript ending in a stock question it
 * recited the stock list; handed "Hello" plus a pending checkout it wrote
 * an order and issued a payment link. Both got guards, and both guards
 * were patching the same structural fact: an action it should never have
 * been able to reach was one token away at all times.
 *
 * A desk is not a different model and not a different conversation. It is
 * the same runtime, the same basket, the same resolver and the same
 * transcript, answering with different authority.
 *
 * WHERE EACH PIECE LIVES, because this file used to hold two of them and
 * that was the problem:
 *
 *   what was said       policy/intent.ts       a speech act, desk-blind
 *   what happens        policy/transitions.ts  a table, every cell filled
 *   who may be reached  this file              routes and preconditions
 *
 * The action lists that used to be here are gone. They said what a desk
 * COULD do, which duplicated what the transition table says it DOES, and
 * two lists of the same thing drift. The table is exhaustive and the
 * compiler enforces it; this file now only answers "may this caller be
 * moved from here to there, given what is true right now".
 */

export type Desk = 'RECEPTION' | 'SELLER' | 'CHECKOUT' | 'ENQUIRY';

export interface DeskSpec {
  /** what a customer would call this person */
  title: string;
  /** desks it may hand a caller to, before preconditions are checked */
  mayTransferTo: readonly Desk[];
  /** one line, given to the policy model, describing the job */
  brief: string;
}

/**
 * RECEPTION KNOWS NOTHING ABOUT THE SHELF, and that is the entire point.
 *
 * It has no product vocabulary, no catalogue, no stock and no basket. So
 * the failure that started this -- a stock list read out to somebody who
 * said hello -- is not prevented by a rule. It is unsayable, because
 * there is no action here that can produce a product name.
 *
 * Its job is the one a person actually does when they pick up a shop's
 * phone: say who they are, and find out what the call is about.
 */
export const DESKS: Record<Desk, DeskSpec> = {
  RECEPTION: {
    title: 'reception',
    mayTransferTo: ['SELLER', 'CHECKOUT', 'ENQUIRY'],
    brief:
      'You answer the shop phone. You do not know what is in stock and you'
      + ' do not take orders. Find out what the call is about, then hand it'
      + ' to the right person.',
  },

  /**
   * The shopping conversation, which is most of what this system already
   * did. Everything about the catalogue, the resolver and the basket
   * lives here unchanged.
   *
   * It cannot take money. When a customer says they are done, this desk
   * does not check out -- it transfers, and the switchboard checks the
   * basket is not empty before the transfer happens.
   */
  SELLER: {
    title: 'the counter',
    mayTransferTo: ['CHECKOUT', 'ENQUIRY'],
    brief:
      'You are behind the counter. Prices, stock, what is available, what'
      + ' goes in the bag. You cannot take payment -- when they are done'
      + ' adding, hand them to the billing counter.',
  },

  /**
   * THE ONLY DESK THAT TOUCHES MONEY, and the only one that cannot touch
   * the bag.
   *
   * That second half is not a limitation, it is the separation of duties
   * being real rather than announced. A customer who says "ek biscuit
   * bhi" at the billing counter is transferred back, exactly as they
   * would be at a physical one, and the bag becomes editable again.
   *
   * PAYMENT_STATUS_QUERY is here and there is still no action anywhere in
   * this system that marks a payment received. Razorpay answers that
   * question; a sentence never does.
   */
  CHECKOUT: {
    title: 'billing',
    mayTransferTo: ['SELLER', 'ENQUIRY'],
    brief:
      'You are at the billing counter. Read the bill back, take payment,'
      + ' answer questions about a payment. You cannot add or remove'
      + ' anything -- if they want another item, send them back.',
  },

  /**
   * Read-only by construction. Not one action in this space writes.
   */
  ENQUIRY: {
    title: 'enquiries',
    /**
     * READ ONLY, AND THE LIST IS THE PROOF. Every action here answers a
     * question from a row that already exists; not one of them writes.
     *
     * Somebody asking for their last order again is asking to SHOP, and
     * gets handed to the counter to do it -- which is both the honest
     * routing and how a real enquiries desk behaves.
     */
    mayTransferTo: ['SELLER', 'CHECKOUT'],
    brief:
      'You answer questions about orders already placed and money already'
      + ' spent. You do not sell anything and you do not take payment.',
  },
};

export const DEFAULT_DESK: Desk = 'RECEPTION';

/**
 * WHETHER A TRANSFER MAY HAPPEN, decided by state rather than by the
 * sentence that asked for it.
 *
 * The model proposes and this disposes, which is the same shape as the
 * consent guard on checkout: a customer can say anything, and what
 * actually moves is decided by what is true. So nobody talks their way to
 * the billing counter with an empty bag, and the failure mode is a
 * sentence rather than an order.
 *
 * Returns the reason it was refused, or null when it may proceed.
 */
export function refuseTransfer(
  from: Desk,
  to: Desk,
  state: { basketSize: number },
): string | null {
  if (from === to) return 'already there';
  if (!DESKS[from].mayTransferTo.includes(to)) return 'not a route this desk offers';

  /**
   * The billing counter with nothing to bill is the one that matters.
   * Everything downstream of it -- the order row, the Razorpay link --
   * assumes a basket, and an empty one there is how a greeting once
   * became a payment link.
   */
  if (to === 'CHECKOUT' && state.basketSize === 0) return 'nothing in the basket yet';

  return null;
}
