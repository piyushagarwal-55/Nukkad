import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * FIXTURE DATA. Scaffolding until the day 1 calls land.
 *
 * The PRD sets a hard day 2 gate: one real catalogue of 200 to 800 SKUs with
 * stock levels, and 30+ real order voice notes, or the project changes.
 * Faking those inputs is the precise mechanism that killed the last project.
 * This file exists so the pipeline can be built and tested before then, not
 * so it can be demoed.
 *
 * The aliases below ARE worth keeping, though. They are the bridge between
 * trade language and household language and they were written by hand.
 */

const rs = (rupees: number) => Math.round(rupees * 100);

interface SeedSku {
  name: string;
  brand: string | null;
  packSize: number;
  unit: string;
  sell: number;
  cost: number;
  category: string | null;
  aliases: string[];
  stock: number;
}

const CATALOG: SeedSku[] = [
  // --- atta, the highest-volume staple -------------------------------
  { name: 'Aashirvaad Whole Wheat Atta 5kg', brand: 'Aashirvaad', packSize: 5, unit: 'kg',
    sell: 285, cost: 255, category: 'wheat_atta',
    aliases: ['atta', 'aata', 'gehu ka atta', 'chakki atta', 'aashirvaad', 'aashirwad atta'], stock: 12 },
  { name: 'Aashirvaad Whole Wheat Atta 10kg', brand: 'Aashirvaad', packSize: 10, unit: 'kg',
    sell: 550, cost: 495, category: 'wheat_atta',
    aliases: ['bada atta', 'das kilo atta', 'atta bada packet'], stock: 6 },
  { name: 'Fortune Chakki Fresh Atta 5kg', brand: 'Fortune', packSize: 5, unit: 'kg',
    sell: 270, cost: 242, category: 'wheat_atta',
    aliases: ['fortune atta', 'chakki fresh'], stock: 9 },

  // --- rice ----------------------------------------------------------
  { name: 'India Gate Basmati Rice 5kg', brand: 'India Gate', packSize: 5, unit: 'kg',
    sell: 540, cost: 480, category: 'rice',
    aliases: ['chawal', 'basmati', 'basmati chawal', 'india gate'], stock: 8 },
  { name: 'Daawat Rozana Rice 5kg', brand: 'Daawat', packSize: 5, unit: 'kg',
    sell: 385, cost: 345, category: 'rice',
    aliases: ['sasta chawal', 'rozana chawal', 'daawat'], stock: 11 },
  { name: 'Sona Masoori Rice 5kg', brand: null, packSize: 5, unit: 'kg',
    sell: 320, cost: 285, category: 'rice',
    aliases: ['sona masoori', 'south wala chawal'], stock: 7 },

  // --- oil. Fortune is deliberately OUT OF STOCK to exercise ---------
  // --- the substitution ranker in the demo ----------------------------
  { name: 'Fortune Sunflower Oil 1L', brand: 'Fortune', packSize: 1, unit: 'l',
    sell: 155, cost: 140, category: 'edible_oil',
    aliases: ['tel', 'peela wala tel', 'sunflower tel', 'fortune tel', 'refined tel'], stock: 0 },
  { name: 'Sundrop Sunflower Oil 1L', brand: 'Sundrop', packSize: 1, unit: 'l',
    sell: 162, cost: 146, category: 'edible_oil',
    aliases: ['sundrop tel', 'sundrop'], stock: 14 },
  { name: 'Saffola Gold Oil 1L', brand: 'Saffola', packSize: 1, unit: 'l',
    sell: 185, cost: 168, category: 'edible_oil',
    aliases: ['saffola', 'saffola tel', 'health wala tel'], stock: 10 },
  { name: 'Dhara Mustard Oil 1L', brand: 'Dhara', packSize: 1, unit: 'l',
    sell: 148, cost: 133, category: 'edible_oil',
    aliases: ['sarson ka tel', 'kadwa tel', 'dhara', 'mustard oil'], stock: 16 },

  // --- pulses ---------------------------------------------------------
  { name: 'Toor Dal 1kg', brand: null, packSize: 1, unit: 'kg',
    sell: 165, cost: 148, category: 'pulses',
    aliases: ['dal', 'arhar dal', 'toor dal', 'tur dal', 'peeli dal'], stock: 22 },
  { name: 'Moong Dal 1kg', brand: null, packSize: 1, unit: 'kg',
    sell: 142, cost: 128, category: 'pulses',
    aliases: ['moong', 'moong dal', 'hari dal'], stock: 18 },
  { name: 'Chana Dal 1kg', brand: null, packSize: 1, unit: 'kg',
    sell: 98, cost: 88, category: 'pulses',
    aliases: ['chana dal', 'chane ki dal'], stock: 20 },
  { name: 'Rajma 1kg', brand: null, packSize: 1, unit: 'kg',
    sell: 175, cost: 158, category: 'pulses',
    aliases: ['rajma', 'lal rajma'], stock: 9 },

  // --- sugar, salt, tea ------------------------------------------------
  { name: 'Sugar 1kg', brand: null, packSize: 1, unit: 'kg',
    sell: 52, cost: 45, category: 'sugar',
    aliases: ['cheeni', 'chini', 'shakkar', 'sugar'], stock: 40 },
  { name: 'Tata Salt 1kg', brand: 'Tata', packSize: 1, unit: 'kg',
    sell: 28, cost: 24, category: 'salt',
    aliases: ['namak', 'tata namak', 'salt'], stock: 30 },
  { name: 'Tata Tea Gold 500g', brand: 'Tata', packSize: 500, unit: 'g',
    sell: 305, cost: 270, category: 'tea',
    aliases: ['chai', 'chai patti', 'tata tea', 'gold chai'], stock: 10 },
  { name: 'Red Label Tea 250g', brand: 'Red Label', packSize: 250, unit: 'g',
    sell: 145, cost: 130, category: 'tea',
    aliases: ['red label', 'lal dibba chai'], stock: 12 },

  // --- masala ----------------------------------------------------------
  { name: 'Everest Haldi Powder 500g', brand: 'Everest', packSize: 500, unit: 'g',
    sell: 145, cost: 130, category: 'masala',
    aliases: ['haldi', 'haldi powder', 'turmeric'], stock: 14 },
  { name: 'Everest Mirch Powder 500g', brand: 'Everest', packSize: 500, unit: 'g',
    sell: 175, cost: 158, category: 'masala',
    aliases: ['mirch', 'lal mirch', 'mirchi powder'], stock: 11 },
  { name: 'MDH Garam Masala 100g', brand: 'MDH', packSize: 100, unit: 'g',
    sell: 82, cost: 73, category: 'masala',
    aliases: ['garam masala', 'mdh masala'], stock: 15 },
  { name: 'Dhaniya Powder 500g', brand: null, packSize: 500, unit: 'g',
    sell: 110, cost: 98, category: 'masala',
    aliases: ['dhaniya', 'dhania powder'], stock: 13 },

  // --- everyday --------------------------------------------------------
  { name: 'Parle-G Biscuit 800g', brand: 'Parle', packSize: 800, unit: 'g',
    sell: 92, cost: 80, category: 'biscuit',
    aliases: ['parle g', 'parle', 'biscuit', 'glucose biscuit'], stock: 20 },
  { name: 'Maggi Noodles 12 pack', brand: 'Maggi', packSize: 12, unit: 'pkt',
    sell: 168, cost: 150, category: 'instant',
    aliases: ['maggi', 'noodles'], stock: 18 },
  { name: 'Amul Taaza Milk 1L', brand: 'Amul', packSize: 1, unit: 'l',
    sell: 34, cost: 30, category: 'milk',
    aliases: ['doodh', 'milk', 'amul doodh', 'taaza'], stock: 25 },
  { name: 'Amul Butter 500g', brand: 'Amul', packSize: 500, unit: 'g',
    sell: 285, cost: 258, category: 'dairy',
    aliases: ['makhan', 'butter', 'amul butter'], stock: 8 },
  { name: 'Surf Excel Easy Wash 1kg', brand: 'Surf Excel', packSize: 1, unit: 'kg',
    sell: 128, cost: 114, category: 'household',
    aliases: ['surf', 'detergent', 'kapde dhone ka powder', 'washing powder'], stock: 16 },
  { name: 'Lifebuoy Soap 4 pack', brand: 'Lifebuoy', packSize: 4, unit: 'pc',
    sell: 116, cost: 102, category: 'household',
    aliases: ['sabun', 'nahane ka sabun', 'lifebuoy'], stock: 22 },
  { name: 'Colgate Toothpaste 200g', brand: 'Colgate', packSize: 200, unit: 'g',
    sell: 112, cost: 99, category: 'household',
    aliases: ['manjan', 'toothpaste', 'colgate'], stock: 14 },
  { name: 'Ashirwad Besan 1kg', brand: 'Aashirvaad', packSize: 1, unit: 'kg',
    sell: 96, cost: 85, category: 'flour',
    aliases: ['besan', 'chane ka atta'], stock: 12 },
];

const HOUSEHOLDS = [
  { name: 'Ramesh Sharma', phone: '+918979560165', members: 4, tier: 'SUGGESTED' as const },
  { name: 'Gupta Ji',      phone: '+919000000002', members: 6, tier: 'SUGGESTED' as const },
  { name: 'Anjali Verma',  phone: '+919000000003', members: 3, tier: 'MANUAL' as const },
];

/** Ramesh's steady basket. Repetition is what gives the prior its teeth. */
const REGULARS = [
  'Aashirvaad Whole Wheat Atta 5kg',
  'Fortune Sunflower Oil 1L',
  'Tata Salt 1kg',
  'Sugar 1kg',
  'Toor Dal 1kg',
  'Tata Tea Gold 500g',
];

const DAY = 86_400_000;

async function main() {
  console.log('clearing...');
  await prisma.$transaction([
    prisma.orderLine.deleteMany(), prisma.order.deleteMany(),
    prisma.burnRate.deleteMany(), prisma.nudge.deleteMany(),
    prisma.message.deleteMany(), prisma.conversation.deleteMany(),
    prisma.payment.deleteMany(), prisma.invoice.deleteMany(),
    prisma.supplierBillLine.deleteMany(), prisma.supplierBill.deleteMany(),
    prisma.skuAlias.deleteMany(), prisma.stock.deleteMany(),
    prisma.sku.deleteMany(), prisma.household.deleteMany(),
    prisma.shopUser.deleteMany(), prisma.kirana.deleteMany(),
  ]);

  const kirana = await prisma.kirana.create({
    data: {
      name: 'Sunita Kirana Store',
      ownerName: 'Sunita Devi',
      phone: '+919927306131',
      whatsappNumber: '+919927306131',
      address: 'Malviya Nagar, Jaipur',
      users: { create: { phone: '+919927306131', name: 'Sunita Devi' } },
    },
  });
  console.log(`kirana ${kirana.name}`);

  const skuByName = new Map<string, string>();
  for (const s of CATALOG) {
    const row = await prisma.sku.create({
      data: {
        kiranaId: kirana.id,
        name: s.name, brand: s.brand, packSize: s.packSize, unit: s.unit,
        sellPaise: rs(s.sell), costPaise: rs(s.cost), category: s.category,
        aliases: s.aliases,
        stock: { create: { quantity: s.stock } },
        aliasRows: {
          create: s.aliases.map((a) => ({ alias: a, source: 'OWNER' as const, approved: true })),
        },
      },
    });
    skuByName.set(s.name, row.id);
  }
  console.log(`${CATALOG.length} skus, 1 deliberately out of stock (Fortune oil)`);

  for (const h of HOUSEHOLDS) {
    const hh = await prisma.household.create({
      data: {
        kiranaId: kirana.id, name: h.name, phone: h.phone,
        memberCount: h.members, autonomyTier: h.tier,
      },
    });

    // Ramesh gets real history so the reorder prior has signal to work with.
    if (h.phone !== '+918979560165') continue;

    for (let cycle = 12; cycle >= 1; cycle--) {
      const when = new Date(Date.now() - cycle * 24 * DAY);
      let total = 0;
      const lines: Array<{ skuId: string; sourceText: string; quantity: number;
        unitPricePaise: number; linePaise: number; method: 'EXACT'; confidence: number }> = [];

      for (const name of REGULARS) {
        // he skips the odd item some cycles, which is what real data looks like
        if (Math.random() < 0.12) continue;
        const skuId = skuByName.get(name)!;
        const sku = CATALOG.find((c) => c.name === name)!;
        const qty = name.includes('Sugar') ? 5 : name.includes('Atta') ? 2 : 1;
        const line = rs(sku.sell) * qty;
        total += line;
        lines.push({ skuId, sourceText: sku.aliases[0]!, quantity: qty,
          unitPricePaise: rs(sku.sell), linePaise: line, method: 'EXACT', confidence: 1 });
      }

      await prisma.order.create({
        data: {
          kiranaId: kirana.id, householdId: hh.id,
          status: 'FULFILLED', source: 'TEXT',
          rawText: 'seed history', totalPaise: total,
          createdAt: when, confirmedAt: when,
          lines: { create: lines },
        },
      });
    }
    console.log(`${h.name}: 12 cycles of history seeded`);
  }

  console.log('\ndone. demo household +918979560165, shop +919927306131');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
