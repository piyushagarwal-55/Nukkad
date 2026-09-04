import { prisma } from '@nukkad/db';
import { dueForReorder } from '../depletion/burn.js';
import { rupeeLabel } from '@nukkad/shared';

const DAY = 86_400_000;

export interface CareCallLine {
  skuId: string;
  name: string;
  category: string | null;
  sellPaise: number;
  quantityHint: number | null;
  daysSincePurchase: number | null;
  predictedDepletionAt: Date | null;
  reason: 'DEPLETION_MODEL' | 'RECENT_STAPLE_PURCHASE';
}

export interface CareCallPlan {
  household: {
    id: string;
    name: string;
    phone: string;
    address: string | null;
    autonomyTier: string;
  };
  shop: { id: string; name: string };
  lines: CareCallLine[];
  offer: { title: string; minBasketPaise: number; flatOffPaise: number } | null;
  openingScript: string;
  guardrail: string;
}

function daysSince(at: Date | null | undefined): number | null {
  if (!at) return null;
  return Math.max(0, Math.round((Date.now() - at.getTime()) / DAY));
}

function listItems(lines: CareCallLine[]): string {
  if (lines.length === 1) return lines[0]!.name;
  if (lines.length === 2) return `${lines[0]!.name} aur ${lines[1]!.name}`;
  return `${lines.slice(0, -1).map((l) => l.name).join(', ')} aur ${lines[lines.length - 1]!.name}`;
}

function openingFor(plan: Omit<CareCallPlan, 'openingScript' | 'guardrail'>): string {
  const first = plan.lines[0];
  const item = first?.name ?? 'aapka samaan';
  const since = first?.daysSincePurchase;
  const offer = plan.offer
    ? ` Aur abhi ${plan.offer.title} chal raha hai${plan.offer.flatOffPaise ? `, ${rupeeLabel(plan.offer.flatOffPaise)} bach sakte hain` : ''}.`
    : '';
  const extra = plan.lines.length > 1
    ? ` Mujhe ${listItems(plan.lines)} due lag raha hai.`
    : '';

  return [
    `Namaste ${plan.household.name} ji, main ${plan.shop.name} se bol rahi hoon.`,
    'Agar aap free ho to kya main aapse 2 minute baat kar sakti hoon?',
    since == null
      ? `Mujhe lag raha hai ${item} khatam hone wala hoga.${extra}`
      : `Main dekh rahi hoon aap ${since} din pehle ${item} le gaye the.${extra}`,
    `Agar ghar par khatam ho gaya ho to main order bana doon, seedha ghar pahunch jayega.${offer}`,
    'Aur koi samaan khatam ho to bata dijiye, main usko bhi order mein add kar dungi.',
  ].join(' ');
}

export async function buildCareCallPlans(kiranaId: string, withinDays = 5): Promise<CareCallPlan[]> {
  const [shop, due, offer] = await Promise.all([
    prisma.kirana.findUnique({ where: { id: kiranaId }, select: { id: true, name: true } }),
    dueForReorder(kiranaId, withinDays),
    prisma.offer.findFirst({
      where: {
        kiranaId,
        active: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: [{ flatOffPaise: 'desc' }, { createdAt: 'desc' }],
    }),
  ]);
  if (!shop) return [];

  const grouped = new Map<string, Array<{
    householdId: string;
    household: {
      id: string;
      name: string;
      phone: string;
      address: string | null;
      autonomyTier: string;
    };
    skuId: string;
    sku: { name: string; category: string | null; sellPaise: number };
    lastQty: number | null;
    lastPurchaseAt: Date | null;
    predictedDepletionAt: Date | null;
    reason: CareCallLine['reason'];
  }>>();
  for (const row of due) {
    const rows = grouped.get(row.householdId) ?? [];
    rows.push({ ...row, reason: 'DEPLETION_MODEL' });
    grouped.set(row.householdId, rows);
  }

  /**
   * Demo-friendly fallback: if the burn model has not emitted a due date
   * yet, a recent staple purchase is still enough for a polite outbound
   * check-in. This is separate from the order brain; it only prepares the
   * opening question.
   */
  const since = new Date(Date.now() - Math.max(14, withinDays) * DAY);
  const recent = await prisma.orderLine.findMany({
    where: {
      skuId: { not: null },
      order: { kiranaId, status: { not: 'CANCELLED' }, createdAt: { gte: since } },
      sku: { category: { in: ['sugar', 'rice', 'wheat_atta', 'edible_oil', 'tea', 'salt', 'flour'] } },
    },
    select: {
      skuId: true,
      quantity: true,
      sku: { select: { name: true, category: true, sellPaise: true } },
      order: {
        select: {
          createdAt: true,
          householdId: true,
          household: {
            select: { id: true, name: true, phone: true, address: true, autonomyTier: true },
          },
        },
      },
    },
    orderBy: { order: { createdAt: 'desc' } },
    take: 250,
  });

  const seen = new Set<string>();
  for (const line of recent) {
    if (!line.skuId || !line.sku) continue;
    const age = daysSince(line.order.createdAt);
    if (age == null || age < 3) continue;
    const key = `${line.order.householdId}:${line.skuId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const rows = grouped.get(line.order.householdId) ?? [];
    if (rows.some((row) => row.skuId === line.skuId)) continue;
    rows.push({
      householdId: line.order.householdId,
      household: line.order.household,
      skuId: line.skuId,
      sku: line.sku,
      lastQty: line.quantity,
      lastPurchaseAt: line.order.createdAt,
      predictedDepletionAt: null,
      reason: 'RECENT_STAPLE_PURCHASE',
    });
    grouped.set(line.order.householdId, rows);
  }

  const plans: CareCallPlan[] = [];
  for (const [, rows] of grouped) {
    const household = rows[0]!.household;
    const lines = rows.slice(0, 5).map((row) => ({
      skuId: row.skuId,
      name: row.sku.name,
      category: row.sku.category,
      sellPaise: row.sku.sellPaise,
      quantityHint: row.lastQty,
      daysSincePurchase: daysSince(row.lastPurchaseAt),
      predictedDepletionAt: row.predictedDepletionAt,
      reason: row.reason,
    }));

    const base = {
      household: {
        id: household.id,
        name: household.name,
        phone: household.phone,
        address: household.address,
        autonomyTier: household.autonomyTier,
      },
      shop,
      lines,
      offer: offer
        ? { title: offer.title, minBasketPaise: offer.minBasketPaise, flatOffPaise: offer.flatOffPaise }
        : null,
    };

    plans.push({
      ...base,
      openingScript: openingFor(base),
      guardrail: 'Separate outbound care-call flow. Do not route this opening through the normal WhatsApp order bot.',
    });
  }

  return plans;
}
