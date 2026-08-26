import type { ResolvedLine } from '@nukkad/shared';
import type { GoldenExpected } from './types.js';

/**
 * Matching is by SKU NAME, not id, so the golden set stays readable and
 * survives a database reseed. Names are compared loosely because a human
 * writing the golden set will not reproduce punctuation exactly.
 */
const key = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function scoreLine(
  line: ResolvedLine,
  expected: GoldenExpected[],
): { top1: boolean; top3: boolean; qty: boolean } {
  const want = expected.find((e) => {
    const k = key(e.skuName);
    const got = line.chosen ? key(line.chosen.sku.name) : '';
    return k === got;
  });

  const top1 = Boolean(line.chosen && want);

  const all = [line.chosen, ...line.alternates].filter(Boolean);
  const top3 = all.some((c) => expected.some((e) => key(e.skuName) === key(c!.sku.name)));

  const qty = Boolean(want && Math.abs(want.quantity - line.quantity) < 0.001);

  return { top1, top3, qty };
}

export function toMarkdown(rows: Array<Record<string, string | number>>): string {
  if (!rows.length) return '(no rows)';
  const cols = Object.keys(rows[0]!);
  const head = `| ${cols.join(' | ')} |`;
  const sep = `| ${cols.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${cols.map((c) => String(r[c])).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}
