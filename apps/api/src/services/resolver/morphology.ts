import { normalise } from './normalise.js';

/**
 * THE RECOVERY TIER. Only reached when ordinary matching has already
 * failed, and structurally unable to overrule it.
 *
 * The bug that motivated this: "Aate ka price kya hai?" scored 0.017
 * against "Aashirvaad Whole Wheat Atta 5kg". Not a near miss -- zero. The
 * shop answered a question about the price of flour by reciting its
 * category list, and it did that because two spellings of one word land
 * in different places:
 *
 *   aata   -> ata     the aa+ fold fires
 *   atta   -> atta    nothing fires; gemination is not folded
 *   aate   -> ate     the oblique case is not folded either
 *
 * WHY THIS IS NOT A NEW RULE IN normalise.ts, which is where it clearly
 * wants to go. Because normalise() is on every comparison in the system,
 * so a fold added there to rescue one word changes the score of every
 * pair in the catalogue. The two folds below are exactly the aggressive
 * kind that does damage: collapsing doubles and rewriting final vowels
 * moves "chini" towards "chana" and "chai" towards "cha", and a catalogue
 * of four hundred items has a lot of three-letter Hindi nouns in it. A
 * fold that fixes atta and breaks sugar is not an improvement, and worse,
 * the breakage is silent -- it shows up as a wrong product in someone's
 * bag rather than as a failing test.
 *
 * So the ladder, strongest evidence first:
 *
 *   exact name or alias
 *     > conservative fuzzy match          normalise.ts, unchanged
 *       > morphological recovery          this file
 *         > ask the customer
 *
 * A rung is only descended when the one above it found nothing
 * confident. That is what makes this safe to add: on every query that
 * works today, this code does not run at all, so it cannot regress them.
 */

/**
 * The two folds that ordinary normalisation deliberately does not do.
 *
 * GEMINATION. Doubling a consonant is a real distinction in Devanagari
 * and an arbitrary one in Roman: atta/ata, chinni/chini, chakki/chaki are
 * each one word written two ways, and which way depends on who is typing.
 *
 * THE OBLIQUE CASE, which is grammar and not spelling at all. Hindi
 * masculine nouns in -aa take -e before a postposition: aata becomes
 * aate in "aate ka price", paisa becomes paise, ladka becomes ladke.
 * "Aate ka price kya hai" is CORRECT Hindi -- it is not a typo and not a
 * transcription error, and it is the more natural way to ask. The
 * nominative "atta ka price" is the odd phrasing of the two, which is
 * why this was never going to be fixed by improving the ASR.
 */
function fold(word: string): string {
  return word
    .replace(/([a-z])\1+/g, '$1')
    .replace(/e$/, 'a');
}

/**
 * Every form a word might have been written in, ORIGINAL FIRST.
 *
 * Generated rather than folded in place, because the original has to
 * survive: it is the strongest evidence there is and the recovery forms
 * are the weakest, so a function that overwrote one with the other would
 * be throwing away the very thing that decides between them.
 *
 * Deduplicated, so a word with nothing to recover -- which is most of
 * them -- costs one comparison rather than three.
 */
export function variants(word: string): string[] {
  const conservative = normalise(word);
  const out = [word, conservative, fold(conservative)];
  return [...new Set(out.filter(Boolean))];
}

/**
 * The recovered form used for comparison, on BOTH sides.
 *
 * Folding query and catalogue the same way is equivalent to comparing
 * every variant of one against every variant of the other, for this
 * family of folds, and it is a great deal cheaper: one pass over the
 * catalogue instead of nine comparisons per pair. The equivalence holds
 * because both folds are idempotent and neither depends on the other's
 * output -- aate and atta both reach ata, from opposite directions.
 */
export function recovered(s: string): string {
  return normalise(s).split(' ').map(fold).join(' ');
}
