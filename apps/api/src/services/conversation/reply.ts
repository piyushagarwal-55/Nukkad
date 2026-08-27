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

const words = (text: string): string[] =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/**
 * @param optionCount how many numbered options were actually offered, so a
 *        stray "5" in "5 kilo aata" is not read as tapping option 5
 * @param optionNames the options as PRODUCTS, matched by name.
 *
 *        This exists because the shop stopped numbering things. It asks
 *        "Basmati chahiye ya Sona Masoori?" the way a person would, and a
 *        person answers "basmati" -- not "1". Numbers still work, because
 *        some customers will type one anyway and refusing it would be rude
 *        for no reason.
 */
export function readAnswer(
  text: string,
  optionCount: number,
  optionNames: string[] = [],
): Answer {
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

  /**
   * Named one of the products on offer. Checked before the yes/no
   * vocabulary because "sona masoori" contains no yes or no, and before
   * the length cut because a product name can be four words long.
   */
  const byName = readChoiceByName(text, optionNames);
  if (byName !== null) return { kind: 'CHOICE', index: byName };

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
const NAME_FLOOR = 0.5;
const NAME_GAP = 0.15;

/**
 * WHICH LINE OF THE ORDER DID THEY JUST NAME, if any.
 *
 * A different question from readChoiceByName, and the difference is which
 * way round the coverage runs. Choosing between offered options scores how
 * much of the REPLY is accounted for, which is right when the reply is
 * mostly the answer. Spotting a product inside "sugar nahi chahiye" is the
 * opposite: two of the three words are filler, and coverage over the reply
 * put Sugar 1kg at 0.32 -- under the floor, so the whole order was
 * cancelled instead of one line.
 *
 * So this asks whether a DISTINCTIVE token of the product appears at all.
 * Distinctive means at least four letters and not a pack size: "sugar" and
 * "aashirvaad" identify a line, "1kg" and "500g" do not, and neither does
 * a short word that could be anything.
 */
const isDistinctive = (t: string) => t.length >= 4 && !/^\d/.test(t);

export function namesLine(text: string, lineNames: string[]): number | null {
  const said = new Set(words(text));

  const scored = lineNames.map((name, index) => {
    const marks = words(name).filter(isDistinctive);
    const hit = marks.filter((m) => said.has(m)).length;
    return { index, hit, of: marks.length || 1 };
  }).filter((x) => x.hit > 0);

  if (!scored.length) return null;

  /**
   * Two atta lines and someone says "atta nahi chahiye" is genuinely
   * ambiguous. The proportion of the name they matched breaks it -- and
   * whatever it picks, it beats the old behaviour, which was to cancel
   * everything they had just agreed to.
   */
  scored.sort((a, b) => b.hit / b.of - a.hit / a.of);
  return scored[0]!.index;
}

export function readChoiceByName(text: string, optionNames: string[]): number | null {
  if (!optionNames.length) return null;

  const scored = optionNames
    .map((name, index) => ({ index, score: fuzzyScore(text, name) }))
    .sort((a, b) => b.score - a.score);

  const [best, next] = scored;
  if (!best || best.score < NAME_FLOOR) return null;
  if (next && best.score - next.score < NAME_GAP) return null;
  return best.index;
}
