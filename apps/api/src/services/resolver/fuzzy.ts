import { tokens, normalise } from './normalise.js';

/** Levenshtein, iterative two-row. Small strings, so this is plenty fast. */
function edit(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const ratio = (a: string, b: string): number => {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 0 : 1 - edit(a, b) / m;
};

/**
 * Token-set score. Deliberately forgiving on word order, because
 * 'aashirvaad atta 10kg' and 'atta aashirvaad' are the same intent, and
 * ASR reorders things.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = tokens(query);
  const t = tokens(target);
  if (!q.length || !t.length) return 0;

  let matched = 0;
  for (const qt of q) {
    let best = 0;
    for (const tt of t) {
      const r = qt === tt ? 1 : ratio(qt, tt);
      if (r > best) best = r;
      if (best === 1) break;
    }
    // below 0.7 is noise, not a near-miss
    if (best >= 0.7) matched += best;
  }

  const coverage = matched / q.length;
  const whole = ratio(normalise(query), normalise(target));
  return 0.75 * coverage + 0.25 * whole;
}
