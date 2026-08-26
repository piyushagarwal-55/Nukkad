import { prisma } from '@nukkad/db';

/**
 * Retrieval for the bill agent.
 *
 * WHY TRIGRAMS AND NOT EMBEDDINGS. Vector search earns its keep on long
 * prose, where meaning is spread across many tokens. A product line is
 * three words with a brand and a pack size, and the failure modes are
 * character-level: case, spacing, abbreviation, a missing vowel. Trigram
 * similarity is built for exactly that, runs inside Postgres next to the
 * data, and needs no embedding provider. Groq does not serve embeddings
 * anyway, so a vector path would mean a second vendor for a worse result.
 *
 * The important property is not which index is used. It is that the model
 * never free-recalls: it only ever sees candidates that were retrieved
 * from real rows, and it must choose among them or decline.
 */

export interface KbHit {
  id: string;
  canonical: string;
  brand: string;
  category: string;
  unit: string;
  subnames: string[];
  score: number;
}

export interface SkuHit {
  id: string;
  name: string;
  brand: string | null;
  packSize: number;
  unit: string;
  sellPaise: number;
  costPaise: number | null;
  aliases: string[];
  score: number;
}

/** Strip the noise a wholesale bill adds around the actual product name. */
export function normaliseBillName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b\d+(\.\d+)?\s*(kg|kgs|gm|gms|g|ltr|lt|l|ml|pkt|pcs|pc|nos|no|dz|dozen)\b/g, ' ')
    .replace(/\b(rfd|refined|pouch|packet|jar|tin|box|bag|btl|bottle|pkt)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Nearest entries in the product knowledge base.
 *
 * This is what grounds alias generation. The model is shown the real local
 * names of the closest known products and asked to adapt them, rather than
 * asked to invent names for a product it has only seen as a bill string.
 */
export async function retrieveKb(rawName: string, k = 4): Promise<KbHit[]> {
  const q = normaliseBillName(rawName);
  if (!q) return [];

  return prisma.$queryRawUnsafe<KbHit[]>(
    `SELECT id, canonical, brand, category, unit, subnames,
            similarity("searchText", $1) AS score
       FROM "ProductKb"
      WHERE similarity("searchText", $1) > 0.08
      ORDER BY score DESC
      LIMIT $2`,
    q,
    k,
  );
}

/**
 * Nearest SKUs already in THIS shop's catalogue.
 *
 * Scored on the better of the product name and its best alias, because a
 * shop that has already taught the system "peela tel" should match a bill
 * line for sunflower oil on that alone.
 *
 * This is the query that decides restock-versus-create, and the reason the
 * old exact-name lookup was wrong: `WHERE name = 'AASHIRVAAD ATTA 5KG'`
 * misses `Aashirvaad Atta 5kg` on case alone and silently creates a
 * duplicate SKU with a split stock count.
 */
export async function retrieveSkus(
  kiranaId: string,
  rawName: string,
  k = 5,
): Promise<SkuHit[]> {
  const q = normaliseBillName(rawName);
  if (!q) return [];

  return prisma.$queryRawUnsafe<SkuHit[]>(
    `SELECT s.id, s.name, s.brand, s."packSize", s.unit,
            s."sellPaise", s."costPaise", s.aliases,
            GREATEST(
              similarity(lower(s.name), $2),
              COALESCE((SELECT MAX(similarity(lower(a), $2))
                          FROM unnest(s.aliases) AS a), 0)
            ) AS score
       FROM "Sku" s
      WHERE s."kiranaId" = $1
        AND s.active
      ORDER BY score DESC
      LIMIT $3`,
    kiranaId,
    q,
    k,
  );
}

/**
 * Thresholds, in one place because they are the tuning surface.
 *
 * AUTO is deliberately high. A wrong auto-match merges two different
 * products into one SKU and corrupts both the stock count and the price,
 * which is far more expensive to undo than asking the owner once.
 */
export const MATCH = {
  /** at or above: restock without asking */
  AUTO: 0.62,
  /** between REVIEW and AUTO: plausible, but the owner confirms */
  REVIEW: 0.3,
  /** a second candidate this close to the winner makes the call ambiguous */
  RUNNER_UP_GAP: 0.12,
} as const;
