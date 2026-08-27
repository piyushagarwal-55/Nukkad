import type { Sku, ResolvedLine } from '@nukkad/shared';
import { rankLine, DEFAULT_RANK, stripQuantity } from './rank.js';
import type { Prior } from './prior.js';
import { maskActions } from './action.js';

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
  /**
   * The parser has already decided the product comes from the
   * conversation rather than from this message. Then nothing is searched:
   * see the note on productSource in the extraction schema.
   */
  fromState?: boolean;
}

/**
 * Words that point at something already mentioned instead of naming it.
 * What a customer says the moment the shop has quoted them a price.
 */
const POINTERS = new Set([
  'yeh', 'ye', 'yah', 'wo', 'woh', 'vo', 'ise', 'isko', 'iske', 'usko',
  'uske', 'usi', 'isi', 'this', 'that', 'it', 'same', 'wahi', 'yehi',
]);

/**
 * Words that carry no product meaning and must not stop a phrase being
 * read as a pointer. "yeh bhi" is "this one too" -- the bhi is the
 * customer saying ALSO, and requiring every word to be a pointer meant
 * that phrase fell through to the catalogue and matched Sugar, Tata Tea
 * Gold and Red Label Tea. None of which had been mentioned.
 */
const FILLER = new Set([
  'bhi', 'bhee', 'aur', 'zara', 'na', 'to', 'hi', 'ji', 'please', 'too',
  'also', 'wala', 'wali', 'ka', 'ke', 'ki',
  // instruction verbs, which are never products
  'do', 'dena', 'dijiye', 'dedo', 'bhej', 'bhejo', 'bhejna', 'pack',
  'kar', 'karo', 'kro', 'add', 'chahiye', 'chaiye',
  // agreement and refusal: meaningful to the state machine, never a product
  'haan', 'han', 'ha', 'haa', 'yes', 'ok', 'okay', 'theek', 'thik', 'accha',
  'nahi', 'nai', 'no',
]);

const words = (text: string) =>
  stripQuantity(text)
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w && !FILLER.has(w));

/** the whole phrase is a pointer: "yeh", "wo wala", "yeh bhi" */
export function isPointer(text: string): boolean {
  const ws = words(text);
  return ws.length > 0 && ws.every((w) => POINTERS.has(w));
}

/** a pointer is in there somewhere, among other words */
function hasPointer(text: string): boolean {
  return words(text).some((w) => POINTERS.has(w));
}

export function resolve(input: ResolveInput): Reference[] {
  /**
   * No spans is not the same as nothing to find. The extractor returns a
   * product span most of the time and not always; when it did not, the
   * whole sentence is the span. Scoring is name-into-text now, so the
   * extra grammar costs almost nothing -- which is precisely what makes
   * this fallback safe, and what made it useless before.
   */
  /**
   * MASK THE WHOLE MESSAGE FIRST, THEN JUDGE THE SPANS.
   *
   * Masking each span on its own does not work, because the extractor
   * gets there first: given "haan daal do" it hands back a span of
   * "daal", the phrase is already broken in half, and "daal" alone is a
   * lentil by every measure. The shop added Toor Dal to a customer who
   * had just been quoted the price of sugar.
   *
   * So commands are recognised in the ORIGINAL message, and a span that
   * lives entirely inside one is dropped. That is the negative rule: a
   * catalogue match found wholly within a recognised command is not a
   * product, whatever it scores.
   */
  const whole = maskActions(input.text);

  /**
   * What is left that could name a product -- commands gone, quantities
   * gone, filler and affirmations gone. "haan daal do" leaves nothing;
   * "ek kilo atta daal do" leaves atta.
   */
  /**
   * SPANS WIN WHEN THERE ARE SPANS.
   *
   * The whole-message reasoning below is for messages that named nothing
   * of their own. When the caller has already identified products -- a
   * photographed list, or the policy layer handing over what the customer
   * named -- those are the answer, and each is masked on its own as a
   * guard rather than re-derived from a sentence.
   *
   * Missing this collapsed a five-item shopping list to one line: a photo
   * carries no message text at all, so the masked remainder was empty and
   * the single-reference path took over.
   */
  const spanSurvivors = input.fromState
    ? []
    : input.spans.filter((sp) => maskActions(sp.text).rest.trim().length > 0);

  const productish = spanSurvivors.length ? ['x'] : (input.fromState ? [] : words(whole.rest));

  const referent = input.lastNamed.length === 1 ? input.lastNamed[0]! : null;

  const pointTo = (sku: Sku, span: { text: string; quantity: number; unit: string | null }): Reference => ({
    sourceText: span.text,
    quantity: span.quantity,
    unitHint: span.unit,
    line: {
      sourceText: span.text,
      quantity: span.quantity,
      unitHint: span.unit,
      chosen: { sku, score: 1, fuzzy: 1, specificity: 99, method: 'EXACT' },
      alternates: [],
      confidence: 1,
      needsDisambiguation: false,
    },
    fromPointer: true,
  });

  const first = input.spans[0] ?? { text: input.text, quantity: 1, unit: null };

  if (!productish.length) {
    /**
     * THE STATE RULE, and it is the primary path rather than a fallback.
     *
     * The message names no product of its own, so it is about whatever
     * the conversation was already about. Nothing is searched, because
     * searching can only produce a wrong answer -- "haan daal do" after a
     * sugar price is the sugar.
     */
    const sku = referent && input.catalogue.find((s) => s.id === referent.skuId);
    if (sku) return [pointTo(sku, first)];

    /**
     * The parser said the product was in the conversation and there is
     * nothing there. Report it unresolved so the caller ASKS -- inventing
     * a search at this point is how "yeh" became dry yeast.
     */
    if (input.fromState) {
      return [{
        sourceText: first.text,
        quantity: first.quantity,
        unitHint: first.unit,
        line: null,
        fromPointer: true,
      }];
    }

    /**
     * No referent either, so the mask may have eaten the only product
     * word there was. "ek kilo daal do" from a customer the shop has
     * told nothing yet really is a kilo of dal. Put it back.
     */
    const line = rankLine(
      input.text, first.quantity, first.unit, input.catalogue, input.prior, DEFAULT_RANK,
    );
    return [{
      sourceText: first.text,
      quantity: first.quantity,
      unitHint: first.unit,
      line: line.chosen ? line : null,
      fromPointer: false,
    }];
  }

  /**
   * Something product-like survived. Keep the extractor's spans that
   * overlap it, and fall back to the masked remainder when none do --
   * which is what happens on the runs where it returns no spans at all.
   */
  const spans = spanSurvivors.length
    ? spanSurvivors
    : [{ text: whole.rest, quantity: first.quantity, unit: first.unit }];

  return spans.map((span) => {
    const pointing = isPointer(span.text);

    /**
     * A POINTER RESOLVES TO AN ID, NOT TO A NAME TO RE-MATCH.
     *
     * The first version substituted the referent's NAME and ranked that,
     * which threw away the one thing that made it certain. "Ashirwad
     * Besan 1kg" went back through the matcher, collided with Aashirvaad
     * Atta on the shared brand exactly as the original phrase had, and
     * the shop asked which of three -- having itself named besan one
     * message earlier.
     *
     * The shop already knows which SKU it was talking about. Use it.
     */
    const settled = pointing && referent
      ? input.catalogue.find((s) => s.id === referent.skuId)
      : undefined;

    if (settled) {
      return {
        sourceText: span.text,
        quantity: span.quantity,
        unitHint: span.unit,
        line: {
          sourceText: span.text,
          quantity: span.quantity,
          unitHint: span.unit,
          // the shop named it and they said "that one": nothing is in doubt
          chosen: { sku: settled, score: 1, fuzzy: 1, specificity: 99, method: 'EXACT' },
          alternates: [],
          confidence: 1,
          needsDisambiguation: false,
        },
        fromPointer: true,
      };
    }

    /**
     * Ranked on the MASKED text, so a command can never be mistaken for a
     * product. Falls back to the original when masking left nothing and
     * there was no referent either -- "ek kilo daal do" from a customer
     * the shop has told nothing yet really is a kilo of dal, and the
     * mask would otherwise have eaten the only product word in it.
     */
    const line = rankLine(
      span.text, span.quantity, span.unit,
      input.catalogue, input.prior, DEFAULT_RANK,
    );

    /**
     * A pointer among other words, and nothing else confidently named.
     * "yeh wala atta bhi do" leaves "atta" and gets the atta; "yeh bhi"
     * leaves nothing and means what they were just talking about.
     */
    if (referent && hasPointer(span.text) && (!line.chosen || line.needsDisambiguation)) {
      const sku = input.catalogue.find((s) => s.id === referent.skuId);
      if (sku) {
        return {
          sourceText: span.text,
          quantity: span.quantity,
          unitHint: span.unit,
          line: {
            sourceText: span.text,
            quantity: span.quantity,
            unitHint: span.unit,
            chosen: { sku, score: 1, fuzzy: 1, specificity: 99, method: 'EXACT' },
            alternates: [],
            confidence: 1,
            needsDisambiguation: false,
          },
          fromPointer: true,
        };
      }
    }

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
