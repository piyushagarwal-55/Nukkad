import { prisma } from '@nukkad/db';
import { mark, span } from '../telemetry/span.js';

/**
 * The household's own reorder history.
 *
 * This is the component that makes bad transcription survivable. You never
 * need to hear 'Aashirvaad atta 10kg' correctly. You need it to rank above
 * 399 alternatives given a fuzzy acoustic match plus a strong prior that
 * this household bought it in eleven of the last twelve cycles.
 */
export type Prior = Map<string, number>;

const HALF_LIFE_DAYS = 45;

/**
 * CACHED, because it was the most expensive thing on the hot path.
 *
 * Measured at ~700ms a turn -- a joined query over five hundred order
 * lines, ordered by order date, run again for every single message. And
 * the answer only changes when an order is CONFIRMED, which happens in
 * exactly one place: payments/settle.ts, which invalidates.
 *
 * The TTL is a backstop for orders confirmed by some other route. Sixty
 * seconds is far shorter than the half-life the weighting uses, so a
 * stale prior is indistinguishable from a fresh one in its effect on
 * ranking.
 */
interface Entry { prior: Prior; loadedAt: number }

const cache = new Map<string, Entry>();
const TTL_MS = 60_000;

export function invalidatePrior(householdId?: string): void {
  if (householdId) cache.delete(householdId);
  else cache.clear();
}

export async function buildPrior(householdId: string): Promise<Prior> {
  const hit = cache.get(householdId);
  if (hit && Date.now() - hit.loadedAt < TTL_MS) {
    mark('prior', 'hit');
    return hit.prior;
  }

  return cache.set(householdId, { prior: await span('db.prior', () => load(householdId)), loadedAt: Date.now() })
    .get(householdId)!.prior;
}

async function load(householdId: string): Promise<Prior> {
  const lines = await prisma.orderLine.findMany({
    where: {
      skuId: { not: null },
      order: { householdId, status: { in: ['CONFIRMED', 'FULFILLED'] } },
    },
    select: { skuId: true, order: { select: { createdAt: true } } },
    orderBy: { order: { createdAt: 'desc' } },
    take: 500,
  });

  const now = Date.now();
  const raw = new Map<string, number>();

  for (const l of lines) {
    if (!l.skuId) continue;
    const ageDays = (now - l.order.createdAt.getTime()) / 86_400_000;
    // recent purchases count for more, but old ones never go to zero
    const weight = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    raw.set(l.skuId, (raw.get(l.skuId) ?? 0) + weight);
  }

  // squash to 0..1 so the prior can never dominate a clearly better match
  const max = Math.max(1, ...raw.values());
  const out: Prior = new Map();
  for (const [k, v] of raw) out.set(k, Math.log1p(v) / Math.log1p(max));
  return out;
}
