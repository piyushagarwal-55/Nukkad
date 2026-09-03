import { prisma } from '@nukkad/db';
import { rupeeLabel } from '@nukkad/shared';
import { suggestOrder, type OrderLineSuggestion } from '../suppliers/order.js';

/**
 * THE NIGHT SHIFT.
 *
 * Every other agent in this system answers somebody. This one answers
 * nobody: it wakes up when the shop is shut, reads what the day did to
 * the shelf and what customers asked for and could not get, and drafts
 * the order the shopkeeper would otherwise write from memory at 11pm.
 *
 * TWO SOURCES, and they are different kinds of fact. Stock velocity says
 * what is RUNNING OUT -- goods the shop already sells, arithmetic on
 * rows it owns. The unmet-demand ledger says what is MISSING -- things
 * customers asked for that the shop has never stocked, which no stock
 * count could ever reveal. A kirana has always had a rough sense of the
 * first and no way at all to see the second.
 *
 * WHAT THIS FILE MAY NOT DO: send anything, approve anything, or decide
 * a rupee. It drafts. A human is asked next, and until that human
 * answers this order is a row and nothing else.
 */

/** how many distinct households must ask before a missing product is worth stocking */
const DEMAND_HOUSEHOLDS = 2;
/** how many times it must have been asked, in total */
const DEMAND_ASKS = 2;
/** how far back the ledger is read */
const DEMAND_DAYS = 14;
/** first order of something the shop has never sold */
const TRIAL_QTY = 6;

export interface DraftLine {
  skuId: string | null;
  name: string;
  quantity: number;
  why: string;
  inStock: number;
  costPaise: number | null;
}

/**
 * Products customers asked for that this shop could not sell them, and
 * that enough different households wanted to be worth shelf space.
 *
 * The households count matters more than the ask count: one person
 * asking five times is one person, and stocking for them is a favour
 * rather than a decision.
 */
async function unmetWorthStocking(kiranaId: string): Promise<DraftLine[]> {
  const since = new Date(Date.now() - DEMAND_DAYS * 86_400_000);
  const rows = await prisma.unmetDemand.findMany({
    where: { kiranaId, createdAt: { gte: since } },
    select: { query: true, householdId: true },
  });

  const byPhrase = new Map<string, { asks: number; households: Set<string> }>();
  for (const r of rows) {
    const key = r.query.trim().toLowerCase();
    if (!key) continue;
    const e = byPhrase.get(key) ?? { asks: 0, households: new Set<string>() };
    e.asks++;
    if (r.householdId) e.households.add(r.householdId);
    byPhrase.set(key, e);
  }

  /**
   * Already handled? A phrase the shopkeeper has ordered, ignored or
   * declared stocked is a decision already taken, and re-proposing it
   * every night is how a useful alert becomes noise somebody mutes.
   */
  const settled = new Set(
    (await prisma.restockAction.findMany({
      where: { kiranaId, status: { in: ['ORDERED', 'IGNORED', 'STOCKED'] } },
      select: { query: true },
    })).map((a) => a.query.trim().toLowerCase()),
  );

  const out: DraftLine[] = [];
  for (const [phrase, e] of byPhrase) {
    if (settled.has(phrase)) continue;
    if (e.asks < DEMAND_ASKS || e.households.size < DEMAND_HOUSEHOLDS) continue;
    out.push({
      skuId: null,
      name: phrase,
      quantity: TRIAL_QTY,
      why: `${e.households.size} gharon ne ${e.asks} baar maanga, apne paas nahi hai`,
      inStock: 0,
      costPaise: null,
    });
  }
  return out.sort((a, b) => b.quantity - a.quantity).slice(0, 5);
}

/** Everything worth ordering tonight, both kinds, in one list. */
export async function planTonight(kiranaId: string): Promise<DraftLine[]> {
  const [low, unmet] = await Promise.all([
    suggestOrder(kiranaId),
    unmetWorthStocking(kiranaId),
  ]);

  const skus = await prisma.sku.findMany({
    where: { id: { in: low.map((l) => l.skuId) } },
    select: { id: true, costPaise: true },
  });
  const cost = new Map(skus.map((s) => [s.id, s.costPaise]));

  const fromStock: DraftLine[] = low.map((l: OrderLineSuggestion) => ({
    skuId: l.skuId,
    name: l.name,
    quantity: l.quantity,
    why: l.why,
    inStock: l.inStock,
    costPaise: cost.get(l.skuId) ?? null,
  }));

  return [...fromStock, ...unmet];
}

/**
 * An order the owner can read at a glance and answer in one line.
 *
 * Numbered, because every edit the owner can make refers to a line and
 * "atta wala hata do" is harder to get wrong when the atta is item 2.
 * The estimate is marked as an estimate and omitted entirely when the
 * shop has no cost basis -- this system does not invent a rupee figure
 * to look complete.
 */
export function renderForOwner(shopName: string, lines: DraftLine[]): string {
  const known = lines.filter((l) => l.costPaise != null);
  const estimate = known.reduce((s, l) => s + (l.costPaise ?? 0) * l.quantity, 0);

  const rows = lines.map((l, i) =>
    `${i + 1}. ${l.name} — ${l.quantity} packet\n   (${l.why})`);

  const money = known.length === lines.length && estimate > 0
    ? `Andaazan ${rupeeLabel(Math.round(estimate))} ka hoga.`
    : known.length
      ? `Jinke daam pata hain unka andaazan ${rupeeLabel(Math.round(estimate))}.`
      : null;

  return [
    `${shopName} — aaj raat ka stock order:`,
    '',
    ...rows,
    '',
    ...(money ? [money, ''] : []),
    'Theek hai? "haan" bolein to distributor ko bhej dunga.',
    'Badalna ho to bata dijiye — "2 number hata do", "atta 5 kar do",',
    'ya "cancel" bol dijiye.',
  ].join('\n');
}

/**
 * Draft tonight's order and record it. Returns null when there is
 * nothing worth waking the owner for, which is most nights in a
 * well-stocked shop and is a success rather than a failure.
 */
export async function draftPurchaseOrder(kiranaId: string) {
  const lines = await planTonight(kiranaId);
  if (!lines.length) return null;

  const supplier = await prisma.supplier.findFirst({
    where: { kiranaId, active: true },
    orderBy: { createdAt: 'asc' },
  });

  return prisma.purchaseOrder.create({
    data: {
      kiranaId,
      supplierId: supplier?.id ?? null,
      status: 'DRAFT',
      reason: `${lines.length} item — stock aur maang ke hisaab se`,
      lines: { create: lines.map((l) => ({
        skuId: l.skuId,
        name: l.name,
        quantity: l.quantity,
        why: l.why,
        inStock: l.inStock,
        costPaise: l.costPaise,
      })) },
    },
    include: { lines: true },
  });
}
