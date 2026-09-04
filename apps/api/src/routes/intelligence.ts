import type { FastifyInstance } from 'fastify';
import { prisma } from '@nukkad/db';
import { requireSession } from './auth.js';
import { normalise } from '../services/resolver/normalise.js';
import { buildCareCallPlans } from '../services/care-call/plan.js';

const DAY = 86_400_000;

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((a.getTime() - b.getTime()) / DAY));
}

function daysFromNow(at: Date | null): number | null {
  if (!at) return null;
  return Math.round((at.getTime() - Date.now()) / DAY);
}

function lastDate(rows: Array<{ createdAt: Date }>): Date | null {
  return rows.reduce<Date | null>((m, row) => (!m || row.createdAt > m ? row.createdAt : m), null);
}

/**
 * THE INTELLIGENCE LAYER OF THE DASHBOARD, and the rule every endpoint
 * here obeys: every summary drills into evidence, and every insight
 * leads to an action. A number a shopkeeper cannot click through to the
 * customers behind it is decoration; a recommendation with no button is
 * a poster.
 *
 * Nothing in this file invents. Attention cards are arithmetic over
 * stock velocity and the unmet ledger; customer patterns are order-gap
 * medians; workforce metrics are aggregations over AgentEvent rows that
 * handle() writes as turns actually happen. Where a number cannot be
 * known honestly -- the rupee value of demand for a product the shop
 * does not price -- it is not shown.
 */
export async function intelligenceRoutes(app: FastifyInstance) {
  /**
   * WHAT NEEDS YOUR ATTENTION: at most three cards, each traceable.
   *
   *   red     stock will run out, at the current week's velocity
   *   orange  repeatedly asked for, not stocked
   *   green   a regular is overdue their usual cycle
   */
  app.get('/intel/attention', async (req) => {
    const { kiranaId } = requireSession(req);
    const since7 = new Date(Date.now() - 7 * 86_400_000);

    const [lines7, stocks, unmet, households] = await Promise.all([
      prisma.orderLine.findMany({
        where: { skuId: { not: null }, order: { kiranaId, status: { not: 'CANCELLED' }, createdAt: { gte: since7 } } },
        select: { skuId: true, quantity: true, sku: { select: { name: true } } },
      }),
      prisma.stock.findMany({
        where: { sku: { kiranaId, active: true } },
        select: { skuId: true, quantity: true },
      }),
      prisma.unmetDemand.findMany({
        where: { kiranaId, createdAt: { gte: since7 } },
        select: { query: true, householdId: true },
      }),
      prisma.household.findMany({
        where: { kiranaId },
        select: {
          id: true, name: true,
          orders: {
            where: { status: { not: 'CANCELLED' } },
            select: { createdAt: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
    ]);

    const cards: Array<{ level: 'red' | 'orange' | 'green'; title: string; body: string; href: string }> = [];

    // ---- stock vs velocity: days left at this week's rate
    const stockOf = new Map(stocks.map((s) => [s.skuId, s.quantity]));
    const sold = new Map<string, { name: string; units: number }>();
    for (const l of lines7) {
      const g = sold.get(l.skuId!) ?? { name: l.sku?.name ?? '?', units: 0 };
      g.units += l.quantity;
      sold.set(l.skuId!, g);
    }
    let worst: { name: string; days: number; stock: number; weekly: number } | null = null;
    for (const [skuId, g] of sold) {
      const stock = stockOf.get(skuId) ?? 0;
      const perDay = g.units / 7;
      if (perDay <= 0) continue;
      const days = stock / perDay;
      if (days <= 3 && (!worst || days < worst.days)) {
        worst = { name: g.name, days, stock, weekly: g.units };
      }
    }
    if (worst) {
      cards.push({
        level: 'red',
        title: `${worst.name} ${worst.days < 1 ? 'aaj hi' : `${Math.ceil(worst.days)} din mein`} khatam ho sakta hai`,
        body: `${worst.stock} bache hain; is hafte ${worst.weekly} bike. Isi raftaar se shelf khali ho jayegi.`,
        href: '/dashboard/inventory',
      });
    }

    // ---- unmet demand: most-asked phrase this week
    const asks = new Map<string, { sample: string; times: number; homes: Set<string> }>();
    for (const u of unmet) {
      const key = normalise(u.query);
      const g = asks.get(key) ?? { sample: u.query, times: 0, homes: new Set<string>() };
      g.times++;
      if (u.householdId) g.homes.add(u.householdId);
      asks.set(key, g);
    }
    const top = [...asks.values()].sort((a, b) => b.times - a.times)[0];
    if (top && top.times >= 2) {
      cards.push({
        level: 'orange',
        title: `Customers baar-baar "${top.sample}" maang rahe hain`,
        body: `${top.times} baar, ${top.homes.size} ghar se, sirf is hafte -- aur shop mein hai nahi.`,
        href: `/dashboard/insights/demand?q=${encodeURIComponent(top.sample)}`,
      });
    }

    // ---- a regular overdue their usual cycle
    let due: { id: string; name: string; gapDays: number; sinceDays: number } | null = null;
    for (const h of households) {
      if (h.orders.length < 3) continue;
      const gaps: number[] = [];
      for (let i = 1; i < h.orders.length; i++) {
        gaps.push((h.orders[i]!.createdAt.getTime() - h.orders[i - 1]!.createdAt.getTime()) / 86_400_000);
      }
      gaps.sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)]!;
      const since = (Date.now() - h.orders[h.orders.length - 1]!.createdAt.getTime()) / 86_400_000;
      if (median >= 1 && since > median * 1.25 && (!due || since - median > due.sinceDays - due.gapDays)) {
        due = { id: h.id, name: h.name, gapDays: Math.round(median), sinceDays: Math.round(since) };
      }
    }
    if (due) {
      cards.push({
        level: 'green',
        title: `${due.name} ka repeat order due lag raha hai`,
        body: `Aam taur par har ${due.gapDays} din mein order karte hain; ab ${due.sinceDays} din ho gaye.`,
        href: `/dashboard/customers/detail?householdId=${due.id}`,
      });
    }

    return { cards };
  });

  /**
   * EVERY CUSTOMER, as a row that opens into a person.
   */
  app.get('/intel/customers', async (req) => {
    const { kiranaId } = requireSession(req);
    const [households, carePlans] = await Promise.all([
      prisma.household.findMany({
        where: { kiranaId },
        select: {
          id: true, name: true, phone: true, address: true, createdAt: true, autonomyTier: true,
          orders: {
            where: { status: { not: 'CANCELLED' } },
            select: { createdAt: true, totalPaise: true },
            orderBy: { createdAt: 'asc' },
          },
          burnRates: {
            select: {
              predictedDepletionAt: true,
              observations: true,
              seeded: true,
              sku: { select: { name: true } },
            },
            orderBy: { predictedDepletionAt: 'asc' },
            take: 12,
          },
          nudges: {
            orderBy: { sentAt: 'desc' },
            take: 1,
            select: { sentAt: true, outcome: true, templateName: true },
          },
        },
      }),
      buildCareCallPlans(kiranaId, 5),
    ]);

    const carePlanByHousehold = new Map(carePlans.map((p) => [p.household.id, p]));

    return {
      customers: households
        .map((h) => {
          const spend = h.orders.reduce((s, o) => s + o.totalPaise, 0);
          const last = lastDate(h.orders);
          const gaps: number[] = [];
          for (let i = 1; i < h.orders.length; i++) {
            gaps.push(daysBetween(h.orders[i]!.createdAt, h.orders[i - 1]!.createdAt));
          }
          gaps.sort((a, b) => a - b);
          const medianGapDays = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : null;
          const tracked = h.burnRates.filter((b) => b.predictedDepletionAt);
          const dueTracked = tracked.filter((b) => {
            const days = daysFromNow(b.predictedDepletionAt);
            return days !== null && days <= 5;
          });
          const carePlan = carePlanByHousehold.get(h.id);
          const strongest = dueTracked[0] ?? tracked[0] ?? null;
          return {
            id: h.id,
            name: h.name,
            phone: h.phone,
            address: h.address,
            since: h.createdAt,
            autonomyTier: h.autonomyTier,
            orders: h.orders.length,
            spendPaise: spend,
            avgBasketPaise: h.orders.length ? Math.round(spend / h.orders.length) : 0,
            lastOrder: last,
            medianGapDays,
            daysSinceLast: last ? daysBetween(new Date(), last) : null,
            trackedItems: h.burnRates.length,
            dueItems: carePlan?.lines.length ?? dueTracked.length,
            nextItem: carePlan?.lines[0]?.name ?? strongest?.sku.name ?? null,
            nextItemDays: carePlan?.lines[0]?.predictedDepletionAt
              ? daysFromNow(carePlan.lines[0].predictedDepletionAt)
              : (strongest ? daysFromNow(strongest.predictedDepletionAt) : null),
            lastNudge: h.nudges[0] ?? null,
          };
        })
        .sort((a, b) => (b.dueItems - a.dueItems) || (b.spendPaise - a.spendPaise)),
    };
  });

  /**
   * ONE CUSTOMER, IN FULL: what they buy, how often, what they said
   * recently, and the honest gap -- a staple category they have never
   * bought here. Patterns are medians over their own orders, never a
   * model's guess.
   */
  app.get('/intel/customer/detail', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const householdId = (req.query as { householdId?: string }).householdId;
    if (!householdId) return reply.code(400).send({ error: 'householdId required' });

    const [h, lines, events, catalogue, carePlans, unmet, nudges] = await Promise.all([
      prisma.household.findFirst({
        where: { id: householdId, kiranaId },
        select: {
          id: true, name: true, phone: true, address: true, createdAt: true,
          memberCount: true, autonomyTier: true, streak: true, vetoWindowMins: true, capPaise: true,
          orders: {
            where: { status: { not: 'CANCELLED' } },
            select: {
              id: true, createdAt: true, totalPaise: true, status: true, source: true,
              lines: {
                select: {
                  quantity: true,
                  sourceText: true,
                  linePaise: true,
                  method: true,
                  confidence: true,
                  wasSubstituted: true,
                  sku: { select: { id: true, name: true, category: true, unit: true } },
                },
              },
            },
            orderBy: { createdAt: 'desc' },
          },
          burnRates: {
            select: {
              qtyPerDay: true,
              lastPurchaseAt: true,
              lastQty: true,
              predictedDepletionAt: true,
              observations: true,
              seeded: true,
              updatedAt: true,
              sku: {
                select: {
                  id: true, name: true, category: true, unit: true,
                  stock: { select: { quantity: true, updatedAt: true } },
                },
              },
            },
            orderBy: { predictedDepletionAt: 'asc' },
          },
        },
      }),
      prisma.orderLine.findMany({
        where: { skuId: { not: null }, order: { householdId, kiranaId, status: { not: 'CANCELLED' } } },
        select: { skuId: true, quantity: true, sku: { select: { name: true, category: true } } },
      }),
      prisma.agentEvent.findMany({
        where: { householdId, kiranaId },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
      prisma.sku.findMany({
        where: { kiranaId, active: true },
        select: { category: true },
        distinct: ['category'],
      }),
      buildCareCallPlans(kiranaId, 14),
      prisma.unmetDemand.findMany({
        where: { kiranaId, householdId },
        orderBy: { createdAt: 'desc' },
        take: 12,
      }),
      prisma.nudge.findMany({
        where: { householdId },
        orderBy: { sentAt: 'desc' },
        take: 8,
      }),
    ]);
    if (!h) return reply.code(404).send({ error: 'no such customer' });

    const byProduct = new Map<string, { name: string; times: number; units: number }>();
    const boughtCategories = new Set<string>();
    for (const l of lines) {
      const g = byProduct.get(l.skuId!) ?? { name: l.sku?.name ?? '?', times: 0, units: 0 };
      g.times++;
      g.units += l.quantity;
      byProduct.set(l.skuId!, g);
      if (l.sku?.category) boughtCategories.add(l.sku.category);
    }

    const gaps: number[] = [];
    const asc = [...h.orders].reverse();
    for (let i = 1; i < asc.length; i++) {
      gaps.push((asc[i]!.createdAt.getTime() - asc[i - 1]!.createdAt.getTime()) / 86_400_000);
    }
    gaps.sort((a, b) => a - b);
    const medianGap = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]!) : null;

    // the honest opportunity: a category the shop stocks that this
    // household has never bought here
    const gap = catalogue
      .map((c) => c.category)
      .filter((c): c is string => !!c)
      .find((c) => !boughtCategories.has(c));

    const spend = h.orders.reduce((s, o) => s + o.totalPaise, 0);
    const carePlan = carePlans.find((p) => p.household.id === householdId) ?? null;
    const tracked = h.burnRates.map((b) => {
      const daysUntil = daysFromNow(b.predictedDepletionAt);
      const daysSincePurchase = b.lastPurchaseAt ? daysBetween(new Date(), b.lastPurchaseAt) : null;
      const cycleDays = b.lastQty && b.qtyPerDay > 0 ? Math.round(b.lastQty / b.qtyPerDay) : null;
      const consumedPct = cycleDays && daysSincePurchase !== null
        ? Math.max(0, Math.min(100, Math.round((daysSincePurchase / cycleDays) * 100)))
        : null;
      return {
        skuId: b.sku.id,
        name: b.sku.name,
        category: b.sku.category,
        unit: b.sku.unit,
        qtyPerDay: b.qtyPerDay,
        lastQty: b.lastQty,
        lastPurchaseAt: b.lastPurchaseAt,
        daysSincePurchase,
        predictedDepletionAt: b.predictedDepletionAt,
        daysUntilDepletion: daysUntil,
        observations: b.observations,
        seeded: b.seeded,
        updatedAt: b.updatedAt,
        stockInShop: b.sku.stock?.quantity ?? null,
        consumedPct,
        signal: daysUntil === null
          ? 'learning'
          : daysUntil <= 0
            ? 'likely empty'
            : daysUntil <= 5
              ? 'call window'
              : 'monitoring',
      };
    });
    const dueTracked = tracked.filter((t) => t.daysUntilDepletion !== null && t.daysUntilDepletion <= 5);
    const learnedTracked = tracked.filter((t) => !t.seeded || t.observations > 0).length;
    const nextDue = carePlan?.lines[0]?.name ?? dueTracked[0]?.name ?? null;
    const lastOrder = h.orders[0] ?? null;
    const summaryParts = [
      `${h.name} ke ${tracked.length} item depletion model mein track ho rahe hain.`,
      learnedTracked
        ? `${learnedTracked} item real purchases se calibrated hain; baaki seeded estimates hain.`
        : 'Abhi model seeded estimates se start kar raha hai; orders badhenge to burn rate tighten hoga.',
      nextDue
        ? `${nextDue} abhi outreach ke liye strongest signal hai.`
        : 'Aaj immediate call signal nahi mila.',
      lastOrder
        ? `Last order ${daysBetween(new Date(), lastOrder.createdAt)} din pehle tha.`
        : 'Is customer ka order history abhi empty hai.',
    ];

    return {
      customer: {
        id: h.id, name: h.name, phone: h.phone, address: h.address, since: h.createdAt,
        memberCount: h.memberCount,
        autonomyTier: h.autonomyTier,
        streak: h.streak,
        vetoWindowMins: h.vetoWindowMins,
        capPaise: h.capPaise,
        orders: h.orders.length,
        spendPaise: spend,
        avgBasketPaise: h.orders.length ? Math.round(spend / h.orders.length) : 0,
        medianGapDays: medianGap,
        daysSinceLast: h.orders[0]
          ? Math.round((Date.now() - h.orders[0].createdAt.getTime()) / 86_400_000)
          : null,
      },
      summary: summaryParts.join(' '),
      tracked,
      careCall: carePlan
        ? {
          lines: carePlan.lines,
          offer: carePlan.offer,
          openingScript: carePlan.openingScript,
          guardrail: carePlan.guardrail,
        }
        : null,
      frequent: [...byProduct.values()].sort((a, b) => b.times - a.times).slice(0, 8),
      recentOrders: h.orders.slice(0, 10).map((o) => ({
        id: o.id,
        createdAt: o.createdAt,
        totalPaise: o.totalPaise,
        status: o.status,
        source: o.source,
        lines: o.lines,
      })),
      timeline: events,
      unmetDemand: unmet,
      nudges,
      opportunity: gap
        ? `${h.name} ne abhi tak ${gap} category se kuch nahi liya -- agle relevant order mein suggest karne layak.`
        : null,
    };
  });

  /**
   * CONVERSATIONS: recent turns across customers, and one customer's
   * full timeline -- desks, handoffs, words, latency. Every row here is
   * an AgentEvent handle() wrote as the turn actually happened.
   */
  app.get('/intel/conversations', async (req) => {
    const { kiranaId } = requireSession(req);
    const events = await prisma.agentEvent.findMany({
      where: { kiranaId },
      orderBy: { createdAt: 'desc' },
      take: 120,
    });
    const ids = [...new Set(events.map((e) => e.householdId).filter((x): x is string => !!x))];
    const names = new Map(
      (await prisma.household.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }))
        .map((h) => [h.id, h.name]),
    );
    return {
      events: events.map((e) => ({ ...e, customer: (e.householdId && names.get(e.householdId)) ?? 'unknown' })),
    };
  });

  /**
   * THE WORKFORCE, measured. Turns handled, average latency, handoffs
   * made and received, per desk -- aggregations over the event spine,
   * which is what makes "each agent has a measurable output" a fact
   * rather than a slide.
   */
  app.get('/intel/workforce', async (req) => {
    const { kiranaId } = requireSession(req);
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [events, demandSignals] = await Promise.all([
      prisma.agentEvent.findMany({ where: { kiranaId, createdAt: { gte: since } } }),
      prisma.unmetDemand.count({ where: { kiranaId, createdAt: { gte: since } } }),
    ]);

    const desks = new Map<string, {
      turns: number; latency: number; handoffsOut: number; handoffsIn: number; acts: Map<string, number>;
    }>();
    for (const e of events) {
      const d = desks.get(e.desk) ?? { turns: 0, latency: 0, handoffsOut: 0, handoffsIn: 0, acts: new Map() };
      d.turns++;
      d.latency += e.latencyMs;
      if (e.handoffTo) {
        d.handoffsIn++; // the event's desk is the RECEIVER (desk after transfer)
        const from = desks.get(e.handoffFrom!) ?? { turns: 0, latency: 0, handoffsOut: 0, handoffsIn: 0, acts: new Map() };
        from.handoffsOut++;
        desks.set(e.handoffFrom!, from);
      }
      if (e.act) d.acts.set(e.act, (d.acts.get(e.act) ?? 0) + 1);
      desks.set(e.desk, d);
    }

    return {
      sinceDays: 30,
      demandSignals,
      desks: [...desks.entries()].map(([desk, d]) => ({
        desk,
        turns: d.turns,
        avgLatencyMs: d.turns ? Math.round(d.latency / d.turns) : 0,
        handoffsOut: d.handoffsOut,
        handoffsIn: d.handoffsIn,
        topActs: [...d.acts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([act, n]) => ({ act, n })),
      })),
    };
  });

  /**
   * THE RESTOCK LOOP. A recommendation becomes a row; the row tracks
   * what the shopkeeper did about it. Closing the loop is what turns
   * demand capture into an operating system.
   */
  app.get('/intel/restock', async (req) => {
    const { kiranaId } = requireSession(req);
    return {
      actions: await prisma.restockAction.findMany({
        where: { kiranaId },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    };
  });

  app.post('/intel/restock', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { query } = (req.body ?? {}) as { query?: string };
    if (!query?.trim()) return reply.code(400).send({ error: 'query required' });
    return prisma.restockAction.create({
      data: { kiranaId, query: query.trim() },
    });
  });

  app.post('/intel/restock/status', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const { id, status } = (req.body ?? {}) as { id?: string; status?: string };
    if (!id || !['ORDERED', 'IGNORED', 'STOCKED', 'OPEN'].includes(status ?? '')) {
      return reply.code(400).send({ error: 'id and a valid status required' });
    }
    const updated = await prisma.restockAction.updateMany({
      where: { id, kiranaId },
      data: { status: status! },
    });
    return { ok: updated.count === 1 };
  });
}
