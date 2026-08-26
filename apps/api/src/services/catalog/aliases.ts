import { prisma } from '@nukkad/db';
import { invalidateCatalog } from './cache.js';

/**
 * Sku.aliases is a denormalised string[] because the ranker reads it on
 * every inbound message and must not do a join per SKU. SkuAlias rows are
 * the source of truth; this keeps the fast path in sync.
 *
 * Anything that touches SkuAlias MUST call this afterwards, or the shop
 * approves a local name in the dashboard and the matcher never sees it.
 * It lives here rather than in a route module so bills and catalogue can
 * both reach it without importing each other.
 */
export async function syncAliasArray(skuId: string): Promise<void> {
  const rows = await prisma.skuAlias.findMany({
    where: { skuId, approved: true },
    select: { alias: true },
  });
  const sku = await prisma.sku.update({
    where: { id: skuId },
    data: { aliases: rows.map((r) => r.alias) },
  });
  invalidateCatalog(sku.kiranaId);
}
