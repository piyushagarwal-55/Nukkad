/**
 * READING A REPLY TO A QUESTION.
 *
 * This is deliberately not an LLM call, and the reason is not latency.
 *
 * The failure mode of asking a model "is this yes or no" is that it answers
 * the question you asked instead of the one you meant. "nahi, teen kilo"
 * is not a no, it is a correction, and a model told to classify yes/no will
 * dutifully return no and cancel the order. "haan lekin chini hata do" is
 * not a yes. Both of those must fall through to the order pipeline, which
 * can actually act on them.
 *
 * So this returns UNKNOWN generously, and UNKNOWN is not an error -- it is
 * the instruction to stop treating the message as an answer and start
 * treating it as an order. The vocabulary below can therefore be small
 * without being fragile, because everything it fails to recognise lands
 * somewhere that handles it better.
 *
 * That is the same shape as the rest of the system: a closed set is matched
 * exactly and everything else is handed to a component with more context.
 * A yes/no vocabulary IS a closed set. Product names are not, which is why
 * those go to retrieval and none of them are listed here.
 */

import { fuzzyScore } from '../resolver/fuzzy.js';

export type Answer =
  | { kind: 'CHOICE'; index: number }
  | { kind: 'NONE_OF_THESE' }
  | { kind: 'YES' }
  | { kind: 'NO' }
  | { kind: 'CHANGE' }
  | { kind: 'UNKNOWN' };

/**
 * Whole-word matches only. A substring match reads the "na" in "naya" as a
 * no, and "haan" is inside nothing but itself only by luck.
 */
const YES = ['haan', 'ha', 'han', 'haa', 'yes', 'y', 'ok', 'okay', 'thik', 'theek', 'sahi', 'done', 'ji', 'bhejo', 'bhej', 'confirm'];
const NO = ['nahi', 'nai', 'na', 'no', 'n', 'cancel', 'rehne', 'mat', 'stop'];
const CHANGE = ['badlo', 'badal', 'badlaav', 'change', 'edit', 'hatao', 'hata'];
/** none of the ones you offered */
const NONE = ['koi', 'kuch', 'none', 'neither', 'nothing'];

/**
 * Ways of saying "that is the lot, send it". Kept beside the YES list
 * because saysCheckout() is the union of the two and both are read off
 * the customer's own words.
 */
const DONE = ['bas', 'itna', 'pack', 'checkout', 'order', 'total', 'khatam', 'finish', 'final'];

/**
 * DOES THIS MESSAGE ITSELF ASK TO CHECK OUT.
 *
 * The guard on the one action in this system that moves money before a
 * human looks at it, and it exists because of a trace that should not
 * have been possible:
 *
 *   heard   "Hello."
 *   said    "Payment link neeche hai."   Rs 351.53, order written
 *
 * The policy model was not broken -- asked in isolation it returns GREET
 * at 0.95. What broke it was the transcript. The five messages before
 * this one ended with the shop asking whether to send the order, and a
 * model handed that history plus a pending question will find the
 * agreement it is looking for in a word that does not contain one.
 *
 * That is the same failure as the very first bug in this codebase, in a
 * new place. A message with no PRODUCT in it was sent to a product
 * matcher and a product came back; a message with no CONSENT in it was
 * sent to a policy model and consent came back. Given enough context,
 * it always will.
 *
 * So the model may still choose to check out, and it may not do so
 * unless the customer's own words say something. Deterministic, on the
 * message alone, with no view of the history that caused the problem.
 */
export function saysCheckout(text: string): boolean {
  const ws = words(text);
  return ws.some((w) => YES.includes(w) || DONE.includes(w));
}

const words = (text: string): string[] =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/**
 * @param optionCount how many numbered options were actually offered, so a
 *        stray "5" in "5 kilo aata" is not read as tapping option 5
 *
 *        Matching an answer to a PRODUCT is no longer done here. That is
 *        resolver/pickFrom, which is the same scorer the rest of the
 *        system uses, pointed at the small set of things just offered.
 *        This file went back to what it is good at: reading yes, no and
 *        a tapped digit.
 */
export function readAnswer(text: string, optionCount: number): Answer {
  const ws = words(text);
  if (!ws.length) return { kind: 'UNKNOWN' };

  /**
   * A BARE number is a tap. A number with anything else around it is a
   * quantity, and reading "2 kilo chawal" as "option 2" would silently
   * order the wrong thing -- which is the exact class of bug this whole
   * layer exists to prevent.
   */
  if (ws.length === 1) {
    const n = Number(ws[0]);
    if (Number.isInteger(n) && n >= 1 && n <= optionCount) {
      return { kind: 'CHOICE', index: n - 1 };
    }
  }

  if (ws.length <= 3 && ws.some((w) => NONE.includes(w))) {
    return { kind: 'NONE_OF_THESE' };
  }

  // Longer phrases are amendments, not answers. "haan bhej do" is a yes;
  // "haan lekin chini hata do" is a change of order wearing a yes.
  if (ws.length > 3) return { kind: 'UNKNOWN' };

  if (ws.some((w) => CHANGE.includes(w))) return { kind: 'CHANGE' };
  // no is checked before yes: "haan nahi rehne do" resolves to the negative,
  // which is the safe direction when someone is visibly changing their mind
  if (ws.some((w) => NO.includes(w))) return { kind: 'NO' };
  if (ws.some((w) => YES.includes(w))) return { kind: 'YES' };

  return { kind: 'UNKNOWN' };
}

/**
 * Which of the offered products they named, if any.
 *
 * Separate from readAnswer because the caller must be able to say "this was
 * not a choice" and fall through to the order pipeline. Someone answering
 * "kuch nahi, atta bhej do" has named a product that is not on the list,
 * and forcing it onto the nearest option would order the wrong thing.
 *
 * The gap check is the load-bearing part. Two rices scoring 0.71 and 0.69
 * is not an answer, it is the same ambiguity restated, so it stays
 * unresolved and gets asked again.
 */
