import type { Sku, Candidate } from '@nukkad/shared';
import type { Prior } from '../resolver/prior.js';

/**
 * Substitution is NOT a category lookup, and treating it as one is why
 * quick-commerce swap suggestions get ignored. The right alternative
 * depends on pack-size equivalence, price band, and whether this household
 * has ever accepted that brand before.
 *
 * Same machinery as SKU resolution, second application. That is the point:
 * one ranking core, two jobs, and the second one is free.
 *
 * IMPORTANT SEQUENCING: run this BEFORE the confirm card is built, never
 * after. If you confirm a basket and then discover a stock-out you have to
 * go back to the buyer twice, and a demo that asks twice looks broken.
 */
export interface SubOptions {
  maxPriceDeltaPct: number;
  packTolerancePct: number;
}

export const DEFAULT_SUB: SubOptions = { maxPriceDeltaPct: 25, packTolerancePct: 20 };

export function findSubstitutes(
  target: Sku,
  catalog: Sku[],
  stock: Map<string, number>,
  prior: Prior,
  opts: SubOptions = DEFAULT_SUB,
): Candidate[] {
  const out: Candidate[] = [];

  for (const s of catalog) {
    if (s.id === target.id) continue;
    if ((stock.get(s.id) ?? 0) <= 0) continue;
    if (s.category && target.category && s.category !== target.category) continue;
    if (s.unit !== target.unit) continue;

    const packDelta = Math.abs(s.packSize - target.packSize) / Math.max(target.packSize, 1e-6);
    if (packDelta > opts.packTolerancePct / 100) continue;

    const priceDelta = Math.abs(s.sellPaise - target.sellPaise) / Math.max(target.sellPaise, 1);
    if (priceDelta > opts.maxPriceDeltaPct / 100) continue;

    // cheaper is mildly good, closer pack size is good, and a brand this
    // household has bought before beats a stranger outright
    const priceScore = 1 - priceDelta;
    const packScore = 1 - packDelta;
    const familiarity = prior.get(s.id) ?? 0;

    out.push({
      sku: s,
      score: 0.35 * priceScore + 0.25 * packScore + 0.4 * familiarity,
      /**
       * A substitute has no lexical claim on what was said -- nobody asked
       * for Dhara when they said Fortune. It is offered because the shelf
       * is empty, and `fuzzy` records that honestly rather than borrowing
       * the original's score.
       */
      fuzzy: 0,
      // a substitute matched no name at all, so it claims nothing
      specificity: 0,
      method: 'SUBSTITUTED',
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}
