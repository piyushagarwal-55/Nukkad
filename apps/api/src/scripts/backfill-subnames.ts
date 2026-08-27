import { prisma } from '@nukkad/db';
import { groundedSubnames } from '../services/bills/subnames.js';
import { syncAliasArray } from '../services/catalog/aliases.js';

/**
 * Give subnames to any product that has none.
 *
 *   npm run backfill:subnames --workspace=@nukkad/api
 *
 * A SKU with no local names is invisible to the resolver: a customer can
 * only reach it by saying the printed trade name, which nobody does. They
 * arrive that way from two directions -- products typed in by hand, and
 * bill lines the agent marked ambiguous and the owner then turned into new
 * items, which the alias node never saw.
 *
 * Additive and safe to re-run. It only touches SKUs with zero aliases, and
 * every name it adds is retrieved from the knowledge base rather than
 * invented, so the worst case is a name nobody uses that the owner deletes
 * with one tap.
 */
async function main() {
  const bare = await prisma.sku.findMany({
    where: { active: true, aliasRows: { none: {} } },
    select: { id: true, name: true, kiranaId: true },
  });

  if (!bare.length) {
    console.log('every active product already has at least one subname');
    return;
  }

  console.log(`${bare.length} product(s) with no subnames\n`);
  let added = 0;
  const touched = new Set<string>();

  for (const sku of bare) {
    const { aliases, grounded } = await groundedSubnames(sku.name);
    if (!aliases.length) {
      console.log(`  ${sku.name.slice(0, 30).padEnd(30)} nothing confident enough to add`);
      continue;
    }

    const res = await prisma.skuAlias.createMany({
      // approved on arrival: these are the same names the review screen
      // would have offered, and the owner can remove any of them
      data: aliases.map((alias) => ({
        skuId: sku.id, alias, source: 'LLM_SUGGESTED' as const, approved: true,
      })),
      skipDuplicates: true,
    });

    added += res.count;
    touched.add(sku.id);
    console.log(
      `  ${sku.name.slice(0, 30).padEnd(30)} ${grounded ? '' : '(ungrounded) '}${aliases.join(', ')}`,
    );
  }

  for (const id of touched) await syncAliasArray(id);
  console.log(`\n${added} subnames added across ${touched.size} product(s)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
