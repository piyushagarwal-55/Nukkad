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

/**
 * Stock, cached briefly and invalidated on the one write that matters.
 *
 * "Volatile, so read it fresh" was the right instinct and the wrong
 * conclusion. Measured at 300ms a turn from India to Seoul, and stock
 * only moves in payments/settle.ts -- so a short TTL plus an explicit
 * invalidation there is fresher than a re-read, not staler: settle()
 * clears this the instant it decrements, while a plain re-read would
 * happily serve a value from 299ms ago.
 *
 * The TTL is the floor for how wrong it can be when something OUTSIDE
 * this process writes stock -- a manual edit in the dashboard, say.
 * Ten seconds is well inside the time it takes a customer to type.
 */
interface StockEntry { map: Map<string, number>; loadedAt: number }

const stockCache = new Map<string, StockEntry>();
const STOCK_TTL_MS = 10_000;

export async function getStockMap(kiranaId: string): Promise<Map<string, number>> {
  const hit = stockCache.get(kiranaId);
  if (hit && Date.now() - hit.loadedAt < STOCK_TTL_MS) return hit.map;

  const rows = await prisma.stock.findMany({ where: { sku: { kiranaId } } });
  const map = new Map(rows.map((r) => [r.skuId, r.quantity]));
  stockCache.set(kiranaId, { map, loadedAt: Date.now() });
  return map;
}

export function invalidateStock(kiranaId?: string): void {
  if (kiranaId) stockCache.delete(kiranaId);
  else stockCache.clear();
}
