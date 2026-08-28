import type { SpeechAct } from './intent.js';
import type { Desk } from './desks.js';

/**
 * WHAT THE SHOP DOES ABOUT WHAT WAS SAID. Every cell, written down.
 *
 * This table is the thing that replaces a growing pile of conditions in
 * core.ts. Each of those conditions was added to fix a real failure and
 * each created the gap the next one patched:
 *
 *   if (desk === 'RECEPTION' && depth === 0 && act !== 'GREET' ...)
 *   if (desk !== 'SELLER') return NOT_UNDERSTOOD
 *   if (confidence < FLOOR && act !== 'NOT_UNDERSTOOD')
 *
 * They were not wrong individually. They were an incomplete answer to a
 * question nobody had written down: for every desk, and every kind of
 * thing a customer can say, what happens? Four desks and thirteen speech
 * acts is fifty-two answers, and they existed only as whatever fell out
 * of the order the conditions happened to be in.
 *
 * WHY THE TYPE IS EXHAUSTIVE. `Record<Desk, Record<SpeechAct, Outcome>>`
 * means a missing cell is a compile error, not a customer discovering it.
 * Adding a desk or a speech act now fails the build until somebody has
 * decided what every combination means -- which is the property the
 * conditions could never have, because a chain of ifs has no way to
 * notice a case nobody thought of.
 *
 * WHERE THE SAFETY LIVES NOW, and it moved rather than disappeared.
 * Before this, CHECKOUT was unsayable at the counter: it was not in that
 * desk's enum, so no prompt could produce it. Speech acts are shared, so
 * the seller CAN now report a CHECKOUT act -- and the cell below turns it
 * into a TRANSFER, which refuseTransfer() will not perform on an empty
 * basket. Both versions are deterministic code; this one is legible.
 *
 * Read the CHECKOUT column and the PAYMENT_CLAIM row before changing
 * anything. Between them they are every path money can take.
 */

export type Outcome =
  /** answer socially. No products, no state change. */
  | 'GREET'
  /** reception's question: what is this call about */
  | 'ASK_PURPOSE'
  /** resolve the named products and put them in the basket */
  | 'ADD_NAMED'
  /** they pointed at something already discussed. Never searches. */
  | 'ADD_REFERENT'
  /**
   * CHANGE WHAT IS IN THE BAG, in whichever direction they meant.
   *
   * This was 'REMOVE', which read the act rather than the sentence and
   * got "nahi teen kilo chini karo" wrong: the model correctly returned
   * MODIFY with an entity of three kilos of sugar, and the table threw
   * the sugar out instead of changing it to three.
   *
   * A restatement and a removal are the same speech act -- both change
   * the bag -- and which one it is depends on whether they said an
   * amount. That is a resolution detail, so execution decides it rather
   * than the table growing a second row for it.
   */
  | 'CHANGE_BASKET'
  /** price, stock, what is available */
  | 'ANSWER_ABOUT_PRODUCT'
  /** the shop picks, and says why */
  | 'RECOMMEND'
  /** yes, to the outstanding question */
  | 'USE_PENDING'
  /** no, to the outstanding question */
  | 'DROP_PENDING'
  /** send the last order again */
  | 'REPEAT_ORDER'
  /** how much have I spent */
  | 'ACCOUNT'
  /** where their order is, answered from the order row */
  | 'ORDER_STATUS'
  /**
   * WHAT OFFERS APPLY, answered from the Offer table and never invented.
   * The "marketing agent" is this lookup: a customer asking about
   * discounts hears "ek second, dekh raha hoon" and then rows from a
   * database, because a discount a model made up is a rupee loss a
   * shopkeeper actually pays.
   */
  | 'QUOTE_OFFER'
  /** freeze the basket, write the order, issue a payment link */
  | 'START_CHECKOUT'
  /** ask Razorpay. Never the customer. */
  | 'VERIFY_PAYMENT'
  /** empty the basket */
  | 'CANCEL'
  /** say plainly that the shop did not follow */
  | 'CLARIFY'
  /** hand the caller to another desk, which then answers this same message */
  | { transfer: Desk };

/**
 * RECEPTION HAS EXACTLY THREE THINGS IT CAN DO: greet, ask why, or put
 * you through. Read down this column -- there is no fourth outcome, and
 * that is what makes "Hello" answered with a stock list impossible
 * rather than merely discouraged.
 *
 * Note UNKNOWN. A receptionist who cannot place a call does not
 * apologise, they transfer it, and being unsure is itself a reason to
 * hand it on. The dead end that produced "samajh nahi aaya" for "daal
 * kaunsi kaunsi hai" was a missing cell, and it is filled here rather
 * than special-cased somewhere else.
 */
const RECEPTION: Record<SpeechAct, Outcome> = {
  /**
   * A GREETING IS ANSWERED BY ASKING WHY THEY CALLED, not by asking what
   * they want to buy.
   *
   * This cell said 'GREET', which is the counter's greeting -- and every
   * one of its variants is a sales question: "Kya chahiye aaj?", "kya
   * bhejun?", "Kya nikaalun?". So the desk with no catalogue was opening
   * every call by asking for an order, which is the original complaint
   * wearing a politer sentence.
   *
   * A person answering a shop's phone does not know yet whether you want
   * to buy, chase an order, or ask what time they close. They ask.
   */
  GREET: 'ASK_PURPOSE',
  BUY: { transfer: 'SELLER' },
  ASK: { transfer: 'SELLER' },
  ASK_RECOMMENDATION: { transfer: 'SELLER' },
  MODIFY: { transfer: 'SELLER' },
  CONFIRM: 'ASK_PURPOSE',
  REJECT: 'ASK_PURPOSE',
  CHECKOUT: { transfer: 'SELLER' },
  PAYMENT_CLAIM: { transfer: 'CHECKOUT' },
  REPEAT_ORDER: { transfer: 'SELLER' },
  ACCOUNT: { transfer: 'ENQUIRY' },
  ORDER_STATUS: { transfer: 'ENQUIRY' },
  ASK_OFFER: { transfer: 'SELLER' },
  CANCEL: { transfer: 'SELLER' },
  UNKNOWN: { transfer: 'SELLER' },
};

/**
 * The counter. Everything about the shelf and the bag lives here, and
 * nothing about money does -- CHECKOUT and PAYMENT_CLAIM both leave.
 */
const SELLER: Record<SpeechAct, Outcome> = {
  GREET: 'GREET',
  BUY: 'ADD_NAMED',
  ASK: 'ANSWER_ABOUT_PRODUCT',
  ASK_RECOMMENDATION: 'RECOMMEND',
  MODIFY: 'CHANGE_BASKET',
  CONFIRM: 'USE_PENDING',
  REJECT: 'DROP_PENDING',
  CHECKOUT: { transfer: 'CHECKOUT' },
  PAYMENT_CLAIM: { transfer: 'CHECKOUT' },
  REPEAT_ORDER: 'REPEAT_ORDER',
  ACCOUNT: { transfer: 'ENQUIRY' },
  ORDER_STATUS: { transfer: 'ENQUIRY' },
  ASK_OFFER: 'QUOTE_OFFER',
  CANCEL: 'CANCEL',
  UNKNOWN: 'CLARIFY',
};

/**
 * THE ONLY DESK THAT TOUCHES MONEY, AND THE ONLY ONE THAT CANNOT TOUCH
 * THE BAG. Both halves are visible in this column.
 *
 * BUY and MODIFY transfer back to the counter, which is the separation
 * of duties being real: a customer who says "ek biscuit bhi" while being
 * billed goes back to the counter, exactly as they would at a physical
 * one, and the bag becomes editable again.
 *
 * PAYMENT_CLAIM maps to VERIFY_PAYMENT and there is no cell anywhere in
 * this file that marks a payment received, because that is not something
 * a sentence can do.
 */
const CHECKOUT: Record<SpeechAct, Outcome> = {
  GREET: 'GREET',
  BUY: { transfer: 'SELLER' },
  ASK: { transfer: 'SELLER' },
  ASK_RECOMMENDATION: { transfer: 'SELLER' },
  MODIFY: { transfer: 'SELLER' },
  CONFIRM: 'USE_PENDING',
  REJECT: 'DROP_PENDING',
  CHECKOUT: 'START_CHECKOUT',
  PAYMENT_CLAIM: 'VERIFY_PAYMENT',
  REPEAT_ORDER: { transfer: 'SELLER' },
  ACCOUNT: { transfer: 'ENQUIRY' },
  ORDER_STATUS: { transfer: 'ENQUIRY' },
  ASK_OFFER: 'QUOTE_OFFER',
  CANCEL: 'CANCEL',
  UNKNOWN: 'CLARIFY',
};

/**
 * Read-only, and the column is the proof: every outcome here either
 * answers from a row that already exists or leaves. Nothing writes.
 */
const ENQUIRY: Record<SpeechAct, Outcome> = {
  GREET: 'GREET',
  BUY: { transfer: 'SELLER' },
  ASK: { transfer: 'SELLER' },
  ASK_RECOMMENDATION: { transfer: 'SELLER' },
  MODIFY: { transfer: 'SELLER' },
  CONFIRM: 'CLARIFY',
  REJECT: 'CLARIFY',
  CHECKOUT: { transfer: 'CHECKOUT' },
  PAYMENT_CLAIM: { transfer: 'CHECKOUT' },
  REPEAT_ORDER: { transfer: 'SELLER' },
  ACCOUNT: 'ACCOUNT',
  ORDER_STATUS: 'ORDER_STATUS',
  ASK_OFFER: 'QUOTE_OFFER',
  CANCEL: { transfer: 'SELLER' },
  UNKNOWN: 'CLARIFY',
};

export const TRANSITIONS: Record<Desk, Record<SpeechAct, Outcome>> = {
  RECEPTION,
  SELLER,
  CHECKOUT,
  ENQUIRY,
};

export const isTransfer = (o: Outcome): o is { transfer: Desk } =>
  typeof o === 'object' && 'transfer' in o;

/**
 * WHEN AN UNSURE READING SHOULD BE TREATED AS UNKNOWN.
 *
 * Below the floor, the shop asks instead of guessing -- a wrong action on
 * a real order costs more than one extra question. But it is applied to
 * the ACT rather than to the outcome now, which fixes the ordering bug
 * that made reception dead-end: an unsure reception simply reads as
 * UNKNOWN, and UNKNOWN at reception is a transfer, not an apology.
 *
 * GREET is exempt because greeting somebody back cannot be the wrong
 * thing to have done.
 */
export const FLOOR = 0.45;

export function readAct(act: SpeechAct, confidence: number): SpeechAct {
  if (act === 'GREET' || act === 'UNKNOWN') return act;
  return confidence < FLOOR ? 'UNKNOWN' : act;
}
