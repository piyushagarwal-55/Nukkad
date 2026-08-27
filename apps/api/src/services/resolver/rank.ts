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
 * How close an alternate must be to the leader before it is worth showing
 * a customer. See the note at the use site.
 */
const ALT_BAND = 0.6;

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

  const query = normalise(sourceText);

  for (const sku of catalog) {
    const names = opts.useAliases
      ? [sku.name, sku.brand ?? '', ...sku.aliases]
      : [sku.name];
    const haystack = names.join(' ');

    let fuzzy = 0;
    let method: ResolutionMethod = 'UNRESOLVED';

    const exact = names.some((n) => n && normalise(n) === query);
    if (exact) {
      fuzzy = 1;
      method = 'EXACT';
    } else if (opts.useFuzzy) {
      fuzzy = fuzzyScore(sourceText, haystack);
      method = 'FUZZY';
    }

    /**
     * THE PRIOR BREAKS TIES. IT DOES NOT NOMINATE CANDIDATES.
     *
     * Without the floor below, a SKU with NO lexical match at all still
     * scored W_PRIOR * p, cleared the 0.05 gate, and could reach the top
     * three. Observed: asked for "chawal", the shop offered Aashirvaad
     * Atta and Sugar 1kg as the options -- not because they sound like
     * chawal, but because Ramesh buys them constantly.
     *
     * That is worse than failing. A shopkeeper who answers "rice?" with
     * "flour or sugar?" is not being helpful, they are being broken, and
     * it is the single most damaging thing the ranker can put in front of
     * a customer.
     *
     * The floor is low on purpose. Everything the prior is FOR still
     * works: "wahi wala atta" has atta in it, and all three sunflower oils
     * clear it lexically before history picks Fortune. What it stops is
     * history inventing a candidate out of nothing.
     */
    const footing = fuzzy >= MIN_LEXICAL_FOR_PRIOR;
    const p = opts.usePrior && footing ? (prior.get(sku.id) ?? 0) : 0;
    if (opts.usePrior && p > 0 && method === 'FUZZY' && fuzzy > 0.3) method = 'PRIOR';

    // Without the prior the score is purely lexical. With it, history can
    // lift a weak lexical match over a stronger one, which is the entire
    // point: you rank rather than transcribe.
    const score = W_FUZZY * fuzzy + W_PRIOR * p;
    if (score > 0.05) scored.push({ sku, score, fuzzy, method });
  }

  scored.sort((a, b) => b.score - a.score);
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
    needsDisambiguation: !chosen || confidence < opts.confidenceFloor,
  };
}
