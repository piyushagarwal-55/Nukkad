import type { Sku, Candidate, ResolvedLine, ResolutionMethod } from '@nukkad/shared';
import { fuzzyScore } from './fuzzy.js';
import { normalise } from './normalise.js';
import type { Prior } from './prior.js';

/**
 * CATALOGUE-CONSTRAINED RANKING. The core of the whole product.
 *
 * Everyone else treats conversation-to-order as a speech problem: hear the
 * words, then extract entities. That framing has a ceiling nobody has
 * beaten. The change in kind is to constrain the decode to a closed known
 * catalogue and condition it on the buyer's own reorder history, so you
 * RANK rather than TRANSCRIBE. Errors that are fatal to extraction are
 * recoverable by retrieval, because the answer is guaranteed to be in a
 * small known set and the prior is strong.
 *
 * The flags below exist so the eval harness can switch each stage off and
 * emit the ablation table from real runs. Do not remove them for tidiness,
 * they ARE the deliverable.
 */
export interface RankOptions {
  /** match against local subnames as well as the printed product name */
  useAliases: boolean;
  /** approximate matching, so ASR noise and spelling drift still land */
  useFuzzy: boolean;
  /** this household's own reorder history breaks ties */
  usePrior: boolean;
  /** below this the buyer gets top-k taps instead of a silent guess */
  confidenceFloor: number;
  topK: number;
}

export const DEFAULT_RANK: RankOptions = {
  useAliases: true,
  useFuzzy: true,
  usePrior: true,
  confidenceFloor: 0.55,
  topK: 3,
};

/**
 * Ablation presets. One row of the table each.
 *
 * `raw` MUST be a real baseline, not a broken one. It is exact string match
 * against the printed product name only, which is exactly what you get from
 * "transcribe, extract entities, look it up" with no retrieval layer. A
 * baseline that resolves nothing by construction makes the table look rigged
 * and is worse than showing no table at all.
 *
 * Aliases count as part of the catalogue constraint, not as a freebie in the
 * baseline, because a household saying "tel" never matches a printed name.
 */
export const ABLATIONS: Record<string, RankOptions> = {
  'raw':               { useAliases: false, useFuzzy: false, usePrior: false, confidenceFloor: 0, topK: 3 },
  'plus-catalogue':    { useAliases: true,  useFuzzy: true,  usePrior: false, confidenceFloor: 0, topK: 3 },
  'plus-prior':        { useAliases: true,  useFuzzy: true,  usePrior: true,  confidenceFloor: 0, topK: 3 },
  'plus-confirmation': { useAliases: true,  useFuzzy: true,  usePrior: true,  confidenceFloor: 0.55, topK: 3 },
};

/**
 * How much lexical footing a SKU needs before its reorder history counts.
 * See the note at the use site: below this, the prior may not vote.
 */
const MIN_LEXICAL_FOR_PRIOR = 0.2;

/**
 * How close two lexical claims must be to count as tied, and therefore
 * to be arbitrated by history rather than decided by it.
 */
const TIE_EPSILON = 0.02;

/**
 * How close an alternate must be to the leader before it is worth showing
 * a customer. See the note at the use site.
 */
const ALT_BAND = 0.6;

/**
 * Words that state an amount rather than name a product. Hinglish number
 * words included, because "do kilo" is written as often as "2 kilo".
 */
const QUANTITY_WORDS = new Set([
  'kilo', 'kilos', 'kg', 'kgs', 'gram', 'grams', 'g', 'gm', 'gms',
  'litre', 'litres', 'liter', 'liters', 'l', 'ltr', 'ml',
  'packet', 'packets', 'pkt', 'pack', 'packs', 'piece', 'pieces', 'pc', 'pcs',
  'bottle', 'bottles', 'box', 'boxes', 'dozen',
  'ek', 'do', 'teen', 'char', 'chaar', 'panch', 'paanch', 'chhe', 'saat',
  'aath', 'nau', 'das', 'adha', 'aadha', 'dedh', 'dhai', 'sava',
]);

/**
 * Drop the amount, keep the product. Returns the input unchanged when
 * stripping would leave nothing -- "do kilo" with no product named is
 * better ranked badly than ranked against an empty string, which matches
 * the same wrong SKU every time.
 */
export function stripQuantity(text: string): string {
  const kept = text.split(/\s+/).filter((w) => {
    const t = w.toLowerCase().replace(/[^a-z]/g, '');
    if (!t) return false;
    return !QUANTITY_WORDS.has(t);
  });
  return kept.length ? kept.join(' ') : text;
}

const W_FUZZY = 0.7;
const W_PRIOR = 0.3;

export function rankLine(
  sourceText: string,
  quantity: number,
  unitHint: string | null,
  catalog: Sku[],
  prior: Prior,
  opts: RankOptions = DEFAULT_RANK,
): ResolvedLine {
  const scored: Candidate[] = [];

  /**
   * RANK THE PRODUCT, NOT THE QUANTITY.
   *
   * The extractor is asked for the product span alone and mostly obliges,
   * but "ek kilo chini" comes back whole often enough to matter. Ranking
   * that string puts "kilo" in play against every pack size in the
   * catalogue, and the damage is not to the winner but to the shortlist:
   * asked for a kilo of chini the shop offered "Sugar 1kg ya Aashirvaad
   * Whole Wheat Atta 10kg", because the atta matched on the word kilo.
   *
   * Stripping is safe here in a way it would not be on the target side.
   * A SKU is called "Toothpaste 150g" and that 150g is identifying; a
   * REQUEST for 150g of it is not, the amount is carried separately in
   * `quantity` and `unitHint`, and pack fitting reads it from there.
   */
  const spoken = stripQuantity(sourceText);
  const query = normalise(spoken);

  /**
   * PASS ONE: what does each SKU's best name claim, lexically.
   *
   * SCORED NAME-INTO-TEXT, PER NAME, and this one direction is the thing
   * the whole resolver turns on. fuzzyScore(a, b) measures how much of A
   * is accounted for by B. The old call asked how much of what the
   * customer SAID is covered by a product, which punishes a question for
   * being a question: "moong dal ka price kitna h" is four parts grammar
   * to two parts product, Moong Dal scored 0.33, and the shop read out
   * its category list instead of a price.
   *
   * Per name rather than against all of them joined, because a product
   * with nine aliases should not be punished for having them. "moong dal"
   * matching perfectly is the signal; the eight that do not appear are
   * noise.
   *
   * SPECIFICITY falls out of the same loop. Every dal answers to "dal",
   * so a dal question matches three SKUs at 1.00 each -- but "moong dal"
   * is two words and both are present, and that is the stronger claim.
   */
  interface Claim { sku: Sku; fuzzy: number; specificity: number; method: ResolutionMethod }
  const claims: Claim[] = [];

  for (const sku of catalog) {
    const names = (opts.useAliases
      ? [sku.name, sku.brand ?? '', ...sku.aliases]
      : [sku.name]
    ).filter(Boolean);

    let fuzzy = 0;
    let specificity = 0;
    let method: ResolutionMethod = 'UNRESOLVED';

    for (const name of names) {
      const isExact = normalise(name) === query;
      const hit = isExact ? 1 : opts.useFuzzy ? fuzzyScore(name, spoken) : 0;
      if (hit <= 0) continue;

      const words = name.split(/\s+/).filter((w) => w.length >= 3).length;
      if (hit > fuzzy || (hit === fuzzy && words > specificity)) {
        fuzzy = hit;
        specificity = Math.max(specificity, words);
        method = isExact ? 'EXACT' : 'FUZZY';
      }
    }

    if (fuzzy > 0) claims.push({ sku, fuzzy, specificity, method });
  }

  /**
   * PASS TWO: history breaks ties, and ONLY ties.
   *
   * "The prior breaks ties" was the stated rule from the start and the
   * arithmetic never enforced it -- W_PRIOR * p was simply added to every
   * candidate, so a strong enough history could lift a vague match over a
   * precise one. Harmless while scores were spread out; not harmless once
   * scoring went name-into-text and shared aliases started producing
   * exact 1.00 ties. Measured, the ablation inverted: catalogue-only rose
   * to 86% and adding the prior DROPPED it to 71%, because history was
   * overruling the lexical evidence rather than arbitrating it.
   *
   * So a candidate only receives its prior when its lexical claim is as
   * good as the best one on offer -- same fuzzy, and no less specific.
   * Three sunflower oils that all answer to "sunflower oil" tie exactly,
   * and history picks Fortune, which is the entire point of the feature.
   * Moong Dal at two words does not tie with Toor Dal at one, so no
   * amount of buying toor dal can turn a moong dal request into it.
   */
  const bestFuzzy = Math.max(0, ...claims.map((c) => c.fuzzy));
  const tied = claims.filter((c) => c.fuzzy >= bestFuzzy - TIE_EPSILON);
  const bestSpecificity = Math.max(0, ...tied.map((c) => c.specificity));

  for (const c of claims) {
    const ties =
      c.fuzzy >= bestFuzzy - TIE_EPSILON &&
      c.specificity >= bestSpecificity &&
      c.fuzzy >= MIN_LEXICAL_FOR_PRIOR;

    const p = opts.usePrior && ties ? (prior.get(c.sku.id) ?? 0) : 0;
    if (p > 0 && c.method === 'FUZZY') c.method = 'PRIOR';

    const score = W_FUZZY * c.fuzzy + W_PRIOR * p;
    if (score > 0.05) {
      scored.push({ sku: c.sku, score, fuzzy: c.fuzzy, specificity: c.specificity, method: c.method });
    }
  }

  const exactCount = scored.filter((c) => c.method === 'EXACT').length;

  /**
   * Sorted by score, then by how PARTICULAR the winning name was. The
   * second term only ever separates ties, which is exactly when a shared
   * alias like "dal" has put three products level.
   */
  scored.sort((a, b) => b.score - a.score || b.specificity - a.specificity);
  const top = scored.slice(0, opts.topK);
  const chosen = top[0] ?? null;

  // Confidence is the MARGIN over the runner-up, not the raw score. A 0.9
  // that beats another 0.89 is a coin flip and must go to the buyer.
  const margin = top.length > 1 ? (top[0]!.score - top[1]!.score) : (chosen?.score ?? 0);
  const confidence = chosen ? Math.min(1, chosen.score * 0.6 + margin * 0.4) : 0;

  /**
   * ALTERNATES MUST BE RIVALS, NOT JUST RUNNERS-UP.
   *
   * top-k by score always returns k things, however bad the k-th is. That
   * is fine for an eval table and wrong for a question put to a customer:
   * asked for "tata wali chai" the shop offered Tata Tea Gold, Aashirvaad
   * Atta and Tata Salt. The tea was right. The atta was there because
   * something had to be, and it makes the shop look like it is guessing.
   *
   * So an alternate has to be within a band of the leader to be worth
   * naming. Genuine ambiguity survives -- three sunflower oils sit within
   * a few points of each other, which is exactly when the buyer should be
   * asked -- and filler does not.
   *
   * BANDED ON `fuzzy`, NOT ON `score`, and the difference is the whole
   * fix. Banding on score did not drop the atta, because the prior had
   * lifted it to within a few points of the tea -- history is precisely
   * what made the wrong answer look competitive. Membership in the option
   * set is a question about what they SAID; the prior only gets to order
   * the list once it is drawn up.
   *
   * This is a PRESENTATION cut, applied after ranking, so the ablation
   * table still measures the ranker rather than this.
   */
  const rivals = chosen
    ? top.slice(1).filter((c) => c.fuzzy >= chosen.fuzzy * ALT_BAND)
    : [];

  return {
    sourceText,
    quantity,
    unitHint,
    chosen,
    alternates: rivals,
    confidence,
    /**
     * AN EXACT NAME IS NOT A QUESTION.
     *
     * Confidence is the MARGIN over the runner-up, which is the right
     * measure nearly everywhere and wrong here. A shop with three dals
     * has three close scores, so "Moong Dal 1kg" -- word for word the
     * product's own name -- scored a thin margin and got asked about:
     *
     *     "Moong Dal 1kg" mein se kaunsa? Moong Dal
     *
     * There is nothing to clarify when the customer has used the exact
     * name. The margin is small because the shop stocks similar things,
     * not because the request was unclear.
     *
     * ONLY WHEN EXACTLY ONE CANDIDATE IS EXACT, though, and the first
     * version of this missed that. Local names are shared: every rice in
     * the catalogue answers to "chawal", so "do kilo chawal" matched
     * three SKUs exactly, the rule fired, and the shop silently picked
     * whichever sorted first instead of asking which rice. An exact match
     * settles a question only when it is the sole exact match.
     */
    needsDisambiguation:
      !chosen ||
      (!(chosen.method === 'EXACT' && exactCount === 1) &&
        confidence < opts.confidenceFloor),
  };
}
