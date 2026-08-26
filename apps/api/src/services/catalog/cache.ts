import { prisma } from '@nukkad/db';
import type { Sku } from '@nukkad/shared';

/**
 * The Supabase project sits in ap-northeast-2 and every query costs about
 * 296ms from India. A 400-SKU catalogue is a few hundred kilobytes, so it
 * has no business being on the hot path. Load once, refresh on write.
 *
 * This alone removes the single largest source of per-message latency.
 */
interface Entry { skus: Sku[]; loadedAt: number }

const cache = new Map<string, Entry>();
const TTL_MS = 5 * 60_000;

export async function getCatalog(kiranaId: string, force = false): Promise<Sku[]> {
  const hit = cache.get(kiranaId);
  if (!force && hit && Date.now() - hit.loadedAt < TTL_MS) return hit.skus;

  const rows = await prisma.sku.findMany({
    where: { kiranaId, active: true },
    include: { stock: true },
  });

  const skus: Sku[] = rows.map((r) => ({
    id: r.id,
    kiranaId: r.kiranaId,
    name: r.name,
    brand: r.brand,
    packSize: r.packSize,
    unit: r.unit,
    sellPaise: r.sellPaise,
    category: r.category,
    aliases: r.aliases,
  }));

  cache.set(kiranaId, { skus, loadedAt: Date.now() });
  return skus;
}

export function invalidateCatalog(kiranaId: string): void {
  cache.delete(kiranaId);
}

/** Stock is volatile, so it is read fresh and NOT cached with the catalogue. */
export async function getStockMap(kiranaId: string): Promise<Map<string, number>> {
  const rows = await prisma.stock.findMany({ where: { sku: { kiranaId } } });
  return new Map(rows.map((r) => [r.skuId, r.quantity]));
}
