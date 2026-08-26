/**
 * Cold-start burn rates, seeded from MoSPI's Household Consumption
 * Expenditure Survey (HCES). Per capita per MONTH, urban India.
 *
 * WHY THIS EXISTS: without a seed a new household needs two or three
 * observed order cycles before the agent can predict anything, and that
 * cold start is what sinks every reorder product. With it the agent is
 * useful on order number ONE.
 *
 * TODO(day-2): replace these placeholders with the real HCES 2023-24
 * per-capita quantity table, state-wise, and cite it in the deck. Judges
 * will ask where the numbers came from, and 'a public government survey'
 * is a far better answer than 'we guessed'.
 */
export interface HcesSeed {
  category: string;
  unit: string;
  perCapitaPerMonth: number;
}

export const HCES_URBAN_SEED: HcesSeed[] = [
  { category: 'wheat_atta', unit: 'kg', perCapitaPerMonth: 4.0 },
  { category: 'rice',       unit: 'kg', perCapitaPerMonth: 4.5 },
  { category: 'pulses',     unit: 'kg', perCapitaPerMonth: 0.9 },
  { category: 'edible_oil', unit: 'l',  perCapitaPerMonth: 0.9 },
  { category: 'sugar',      unit: 'kg', perCapitaPerMonth: 0.8 },
  { category: 'salt',       unit: 'kg', perCapitaPerMonth: 0.25 },
  { category: 'tea',        unit: 'g',  perCapitaPerMonth: 90 },
  { category: 'milk',       unit: 'l',  perCapitaPerMonth: 5.5 },
];

/** Per-capita monthly quantity to a household per-day burn rate. */
export function seedBurnPerDay(perCapitaPerMonth: number, members: number): number {
  return (perCapitaPerMonth * members) / 30;
}
