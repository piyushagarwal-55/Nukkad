import type { Sku, ResolvedLine } from '@nukkad/shared';
import { rankLine, DEFAULT_RANK, stripQuantity } from './rank.js';
import type { Prior } from './prior.js';

/**
 * ONE RESOLUTION STEP, WITH ALL THE CONTEXT, BEFORE ANYONE DECIDES WHAT
 * TO DO ABOUT IT.
 *
 * This exists because the answer to "which product does this phrase mean"
 * used to depend on which branch of the conversation the message happened
 * to land in. There were six of them:
 *
 *   rankLine            fuzzy + prior, top-k        query -> names
 *   matching            max over names              name  -> query
 *   namesLine           distinctive-token overlap   name  -> query
 *   readChoiceByName    fuzzy + margin gap          query -> name
 *   retrieveKb          trigram over the KB
 *   openCategory        KB canonical -> rankLine
 *
 * Different scoring, different directions, different floors -- and they
 * disagreed with each other, which is why every fix moved the symptom
 * rather than removing it. "Basmati Rice 5kg" was an exact answer to a
 * person and ambiguous to the fourth. "moong dal ka price" resolved in
 * the second and not the first, so the reply depended on whether the
 * extractor said QUESTION or UNKNOWN -- and measured over three runs of
 * the same sentence, it said both.
 *
 * WORSE, EACH SAW A DIFFERENT SLICE OF STATE. rankLine knew the
 * household's reorder history but not what the shop had just said.
 * matching knew neither. The composer saw the transcript, which is why
 * the PROSE had context and the DECISIONS did not -- and why "1 kg yeh
 * pack kar do" sent the word yeh to the knowledge base and came back
 * with dry yeast.
 *
 * So: resolution happens once, here, with everything. Intent chooses the
 * VERB afterwards -- price it, add it, remove it, list it -- and a wrong
 * label costs a wrong verb rather than a failed lookup.
 */

/** what the shop believes a phrase referred to */
export interface Reference {
  /** verbatim, as they said it. Never overwritten; the eval harness reads it */
  sourceText: string;
  quantity: number;
  unitHint: string | null;
  /** null when nothing in the catalogue was close enough */
  line: ResolvedLine | null;
  /** true when the phrase pointed at something rather than naming it */
  fromPointer: boolean;
}

export interface ResolveInput {
  /** everything they said this turn, used whenever spans are missing */
  text: string;
  /**
   * Product spans from the extractor, if it found any. A HINT, not a
   * requirement -- the same sentence yields spans on one run and none on
   * the next, and the shop must behave the same either way.
   */
  spans: Array<{ text: string; quantity: number; unit: string | null }>;
  catalogue: Sku[];
  prior: Prior;
  /** what the shop named in its previous reply, for resolving pointers */
  lastNamed: Array<{ skuId: string; name: string }>;
}

/**
 * Words that point at something already mentioned instead of naming it.
 * What a customer says the moment the shop has quoted them a price.
 */
const POINTERS = new Set([
  'yeh', 'ye', 'yah', 'wo', 'woh', 'vo', 'ise', 'isko', 'iske', 'usko',
  'uske', 'usi', 'isi', 'this', 'that', 'it', 'same', 'wahi', 'yehi',
]);

export function isPointer(text: string): boolean {
  const ws = stripQuantity(text).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return ws.length > 0 && ws.every((w) => POINTERS.has(w));
}

export function resolve(input: ResolveInput): Reference[] {
  /**
   * No spans is not the same as nothing to find. The extractor returns a
   * product span most of the time and not always; when it did not, the
   * whole sentence is the span. Scoring is name-into-text now, so the
   * extra grammar costs almost nothing -- which is precisely what makes
   * this fallback safe, and what made it useless before.
   */
  const spans = input.spans.length
    ? input.spans
    : [{ text: input.text, quantity: 1, unit: null }];

  const referent = input.lastNamed.length === 1 ? input.lastNamed[0]! : null;

  return spans.map((span) => {
    const pointing = isPointer(span.text);

    /**
     * A pointer with exactly one thing to point at becomes that thing.
     * With none or several it stays unresolved and the caller asks --
     * never guesses, because guessing here is how "yeh" became dry yeast.
     */
    const text = pointing && referent ? referent.name : span.text;

    const line = rankLine(
      text, span.quantity, span.unit, input.catalogue, input.prior, DEFAULT_RANK,
    );

    return {
      sourceText: span.text,
      quantity: span.quantity,
      unitHint: span.unit,
      line: line.chosen ? line : null,
      fromPointer: pointing,
    };
  });
}

/**
 * Which of a SMALL KNOWN SET they just named.
 *
 * The same scorer against a restricted catalogue, which is all that
 * "answer a question" and "take something out of the basket" ever were.
 * They had two bespoke matchers between them, with their own floors and
 * their own bugs -- one of which asked the same question five times
 * because "Basmati Rice 5kg" is a substring of "India Gate Basmati Rice
 * 5kg" and no reply could break the margin.
 *
 * The prior is deliberately absent: the customer is choosing between
 * things the shop has just put in front of them, and what they usually
 * buy has no vote in that.
 */
const EMPTY_PRIOR: Prior = new Map();

export function pickFrom(text: string, options: Sku[]): number | null {
  if (!options.length) return null;

  const line = rankLine(text, 1, null, options, EMPTY_PRIOR, {
    ...DEFAULT_RANK,
    usePrior: false,
    topK: options.length,
  });

  const top = line.chosen;
  if (!top || top.fuzzy < PICK_FLOOR) return null;

  /**
   * A CLEAR WINNER, not a confident one.
   *
   * `needsDisambiguation` is the wrong test here and using it cost a
   * whole basket. Confidence is calibrated for ranking against a few
   * hundred SKUs; among two or three things the shop has just named, the
   * question is only whether one of them stands out. "sugar nahi
   * chahiye" scores Sugar at 0.50 and Atta at nothing -- obvious to a
   * person, under the open-catalogue floor, so this returned null, the
   * caller read it as a refusal of the whole order, and both items went.
   */
  const next = line.alternates[0];
  const clear =
    !next ||
    top.fuzzy - next.fuzzy >= PICK_GAP ||
    top.specificity > next.specificity;

  return clear ? options.findIndex((s) => s.id === top.sku.id) : null;
}

/** enough of a name to count as having said it */
const PICK_FLOOR = 0.4;
/** how far ahead of the runner-up before it is a choice and not a guess */
const PICK_GAP = 0.15;
