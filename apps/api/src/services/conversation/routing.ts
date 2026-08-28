import { prisma } from '@nukkad/db';
import { mark, span } from '../telemetry/span.js';
import { getCatalog, getStockMap } from '../catalog/cache.js';
import { buildPrior } from '../resolver/prior.js';

/**
 * WHO IS TALKING, cached, and warmed while the ear is still busy.
 *
 * Two facts about a turn that took ten seconds. The first is that finding
 * out whose shop and whose household a message belongs to cost 595ms
 * before any work started -- three sequential queries to a database in
 * ap-northeast-2, roughly 200ms each way from India. The second is that
 * the answers never change during a conversation. A phone number does not
 * move between shops mid-sentence.
 *
 * So they are cached for a minute, the same span the catalogue and the
 * reorder prior already use, and for the same reason: these are facts
 * about the world that change on a human timescale, being re-read on a
 * machine one.
 *
 * WHAT IS NOT CACHED, and the distinction is the whole safety of this
 * file: the CONVERSATION. Its contextJson is rewritten every single turn
 * -- it holds the basket, the pending question and what "yeh" refers to
 * -- so a cached copy would be a stale basket, which is the one thing
 * worse than a slow one. Only the two genuinely static lookups live here.
 *
 * WARMING. On the voice path there is 762ms of ASR during which nothing
 * else happens and both these queries and all three catalogue caches
 * could have been filled. warm() is that: fired alongside the
 * transcription, so by the time there are words to act on, the shop is
 * already known and its catalogue is already in memory. It costs nothing
 * when it loses the race and saves about a second when it wins.
 */

type Route = {
  kirana: Awaited<ReturnType<typeof findKirana>>;
  household: Awaited<ReturnType<typeof findHousehold>>;
};

const findKirana = (recipientId: string) =>
  prisma.kirana.findFirst({
    where: { OR: [{ whatsappNumber: recipientId }, { phone: recipientId }] },
  });

const findHousehold = (senderId: string) =>
  prisma.household.findFirst({
    where: { phone: senderId },
    include: { kirana: true },
  });

const cache = new Map<string, { route: Route; at: number }>();
const TTL_MS = 60_000;

export function invalidateRoute(): void {
  cache.clear();
}

export async function routeOf(senderId: string, recipientId: string): Promise<Route> {
  const key = `${senderId}|${recipientId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    mark('route', 'hit');
    return hit.route;
  }

  const [kirana, household] = await span('db.route', () =>
    Promise.all([findKirana(recipientId), findHousehold(senderId)]));

  const route: Route = { kirana, household };
  cache.set(key, { route, at: Date.now() });
  return route;
}

/**
 * Fill every cache this turn is going to want, before it wants them.
 *
 * Never throws. A warm-up that fails is a warm-up that did not happen,
 * and the real path will do the work again properly -- turning a slow
 * turn into a failed one would be a poor trade.
 */
export async function warm(senderId: string, recipientId: string): Promise<void> {
  try {
    const { kirana, household } = await routeOf(senderId, recipientId);
    const shop = kirana ?? household?.kirana ?? null;
    if (!shop) return;

    await Promise.all([
      getCatalog(shop.id),
      getStockMap(shop.id),
      household ? buildPrior(household.id) : Promise.resolve(undefined),
    ]);
  } catch {
    // losing the race is the normal case, not an error
  }
}
