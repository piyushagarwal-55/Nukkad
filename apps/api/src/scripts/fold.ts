import { rankLine } from '../services/resolver/rank.js';
import type { Sku } from '@nukkad/shared';

/**
 * THE MATCHING LADDER, END TO END.
 *
 *   npm run fold --workspace=@nukkad/api
 *
 * No database and no model, so this runs in milliseconds and can be run
 * on every change to the resolver. What it guards is the thing that made
 * Hindi morphology dangerous to add: a fold aggressive enough to rescue
 * "aate" is aggressive enough to confuse "chini" with "chana", and the
 * confusion is silent -- it shows up as the wrong product in someone's
 * bag rather than as an error.
 *
 * So there are three tables and all three matter equally. RESCUED is the
 * feature. CONFUSABLE is the cost of the feature, held at zero. INTACT is
 * the regression guard: those queries already worked, and the recovery
 * tier must never be the reason one of them changes its answer.
 */

let n = 0;
const sku = (name: string, aliases: string[] = [], paise = 10000): Sku => ({
  id: `s${++n}`,
  kiranaId: 'k',
  name,
  brand: null,
  packSize: 1,
  unit: 'kg',
  sellPaise: paise,
  category: null,
  aliases,
});

/** the collisions are the point: four dals, two attas, chana next to chini */
const CATALOGUE: Sku[] = [
  sku('Aashirvaad Whole Wheat Atta 5kg', ['atta', 'ashirwad']),
  sku('Fortune Chakki Fresh Atta 5kg', ['atta', 'chakki atta']),
  sku('Toor Dal 1kg', ['dal', 'arhar']),
  sku('Moong Dal 1kg', ['dal', 'moong']),
  sku('Chana Dal 1kg', ['dal', 'chana']),
  sku('Sugar 1kg', ['chini', 'shakkar']),
  sku('Tata Salt 1kg', ['namak']),
  sku('Tata Tea Gold 500g', ['chai', 'patti']),
  sku('Basmati Rice 5kg', ['chawal', 'basmati']),
  sku('Fortune Sunflower Oil 1L', ['tel', 'refined']),
  sku('Amul Butter 500g', ['makhan']),
  sku('Everest Haldi Powder 200g', ['haldi']),
];

interface Check {
  say: string;
  /** substring of the name that must win, or null for "nothing confident" */
  want: string | null;
}

/**
 * The bar core.ts applies to a whole-sentence match before it counts as
 * naming a product. rankLine always hands back its best candidate -- it
 * is a ranker, not a judge -- so "nothing confident" is asserted here as
 * "scores below the floor its caller will apply", which is the actual
 * contract between the two.
 */
const CONFIDENT = 0.7;

/**
 * WHAT THE RECOVERY TIER IS FOR. Every one of these scored below the
 * matcher's own threshold before it existed -- "aate" managed 0.017
 * against the atta, which is not a near miss but a zero.
 */
const RESCUED: Check[] = [
  { say: 'aate ka price kya hai', want: 'Atta' },
  { say: 'atte ka rate', want: 'Atta' },
  { say: 'aata bhej do', want: 'Atta' },
  { say: 'daale ka bhav', want: 'Dal' },
  { say: 'chinni chahiye', want: 'Sugar' },
];

/**
 * WHAT IT MUST NOT COST. Collapsing doubles and rewriting final vowels
 * moves short Hindi nouns towards each other, and this shop stocks
 * chana, chini and chai. A wrong answer here is a wrong product in a
 * bag, which nobody finds until delivery.
 */
const CONFUSABLE: Check[] = [
  { say: 'chini chahiye', want: 'Sugar' },
  { say: 'chana dal chahiye', want: 'Chana Dal' },
  { say: 'chai patti bhej do', want: 'Tea' },
  { say: 'namak chahiye', want: 'Salt' },
  { say: 'tel bhej do', want: 'Oil' },
  { say: 'dukaan kitne baje tak khuli hai', want: null },
  { say: 'kuch namkeen bhej do', want: null },
];

/**
 * WHAT MUST NOT MOVE. These resolve on the conservative tier, so the
 * gate should mean the recovery code never runs for them at all. If one
 * of these changes, the gate has leaked.
 */
const INTACT: Check[] = [
  { say: 'do kilo atta bhej dena', want: 'Atta' },
  { say: 'moong dal ka price kitna h', want: 'Moong Dal' },
  { say: 'ashirwad atta', want: 'Aashirvaad' },
  { say: 'chakki wala atta', want: 'Fortune Chakki' },
  { say: 'ek kilo chawal', want: 'Basmati' },
  { say: 'haldi powder', want: 'Haldi' },
];

let failed = 0;

function run(title: string, checks: Check[]) {
  console.log(`\n${title}`);
  for (const c of checks) {
    const line = rankLine(c.say, 1, null, CATALOGUE, new Map());
    const got = line.chosen;
    const ok = c.want === null
      ? !got || got.fuzzy < CONFIDENT
      : !!got && got.sku.name.includes(c.want);

    if (!ok) failed++;
    const shown = got ? `${got.fuzzy.toFixed(3)} ${got.method.padEnd(9)} ${got.sku.name}` : '(nothing)';
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} "${c.say}"`);
    console.log(`       -> ${shown}${ok ? '' : `   wanted ${c.want ?? '(nothing)'}`}`);
  }
}

run('rescued by morphology', RESCUED);
run('must not be confused', CONFUSABLE);
run('must not move', INTACT);

console.log(`\n${failed === 0 ? 'all good' : `${failed} wrong`}`);
process.exit(failed === 0 ? 0 : 1);
