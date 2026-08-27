import { PrismaClient } from '@prisma/client';
import { PRODUCT_KB, kbSearchText } from '@nukkad/shared';

/**
 * Seed the product knowledge base.
 *
 * Separate from the demo seed and safe to run against a live shop: it only
 * touches ProductKb, which is reference data shared by every kirana, and
 * every write is an upsert keyed on (canonical, brand). Run it again after
 * adding entries to product-kb.ts and it converges.
 *
 * Also installs pg_trgm and the trigram indexes the retriever needs. The
 * extension ships with Supabase but is not enabled by default, and without
 * it every similarity() call fails at runtime rather than at deploy.
 *
 *   npm run db:seed:kb
 */
const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS product_kb_search_trgm ON "ProductKb" USING gin ("searchText" gin_trgm_ops)',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS sku_name_trgm ON "Sku" USING gin (name gin_trgm_ops)',
  );

  for (const e of PRODUCT_KB) {
    // empty string, never null: Prisma cannot query a nullable field inside
    // a compound unique, and the lookup key here is (canonical, brand)
    const brand = e.brand ?? '';
    await prisma.productKb.upsert({
      where: { canonical_brand: { canonical: e.canonical, brand } },
      create: {
        canonical: e.canonical,
        brand,
        category: e.category,
        unit: e.unit,
        subnames: e.subnames,
        searchText: kbSearchText(e),
      },
      update: {
        category: e.category,
        unit: e.unit,
        subnames: e.subnames,
        searchText: kbSearchText(e),
      },
    });
  }

  const rows = await prisma.productKb.findMany({ select: { subnames: true, category: true } });
  const subnames = rows.reduce((n, r) => n + r.subnames.length, 0);
  console.log(
    `product knowledge base: ${rows.length} products, ${subnames} subnames, ` +
      `${new Set(rows.map((r) => r.category)).size} categories`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
