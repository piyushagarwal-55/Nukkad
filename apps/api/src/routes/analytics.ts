import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@nukkad/db';
import { requireSession } from './auth.js';

/**
 * Shop analytics.
 *
 * TIMEZONE. Every date here is an IST calendar date, not a UTC one. A shop
 * closing at 9pm generates orders that are already "tomorrow" in UTC, so
 * grouping on the raw timestamp files the whole evening under the next day
 * and every daily figure comes out wrong. All bucketing shifts by +05:30
 * first and only then reads the date part.
 *
 * Aggregation happens in JS rather than SQL for the same reason: expressing
 * an IST day boundary in Prisma's groupBy means raw SQL and a database that
 * agrees about timezones. A kirana has thousands of orders, not millions,
 * so pulling three columns and folding them here is both simpler and
 * exactly correct.
 */

const IST_OFFSET_MS = 330 * 60_000;

/** The IST calendar date this instant falls on, as YYYY-MM-DD. */
function istDay(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC instant of midnight IST, `daysAgo` days before today. */
function istMidnightDaysAgo(daysAgo: number): Date {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const midnightIst = Date.UTC(
    nowIst.getUTCFullYear(),
    nowIst.getUTCMonth(),
    nowIst.getUTCDate() - daysAgo,
  );
  return new Date(midnightIst - IST_OFFSET_MS);
}

/** [start, end) in UTC for an IST calendar month, `YYYY-MM`. */
function istMonthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return {
    start: new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS),
    end: new Date(Date.UTC(y, m, 1) - IST_OFFSET_MS),
  };
}

/**
 * Three buckets, because that is how an owner thinks about it. CONFIRMED is
 * pending rather than fulfilled: the customer agreed, but nothing has left
 * the shop yet and no money has moved.
 */
type Bucket = 'fulfilled' | 'cancelled' | 'pending';
function bucket(status: string): Bucket {
  if (status === 'FULFILLED') return 'fulfilled';
  if (status === 'CANCELLED') return 'cancelled';
  return 'pending';
}

const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .optional();
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function analyticsRoutes(app: FastifyInstance) {
  app.get('/analytics', async (req, reply) => {
    const { kiranaId } = requireSession(req);

    const q = req.query as { month?: string };
    const parsedMonth = monthSchema.safeParse(q.month);
    if (!parsedMonth.success) {
      return reply.code(400).send({ error: 'month must look like 2026-08' });
    }
    const month = parsedMonth.data ?? istDay(new Date()).slice(0, 7);

    const orders = await prisma.order.findMany({
      where: { kiranaId },
      select: { createdAt: true, status: true, totalPaise: true },
      orderBy: { createdAt: 'asc' },
    });

    // ---- status split, all time ------------------------------------
    const status = { fulfilled: 0, cancelled: 0, pending: 0 };
    for (const o of orders) status[bucket(o.status)] += 1;

    /**
     * Revenue counts everything that is not cancelled. A cancelled order
     * never earned anything, but a pending one is money the shop is owed
     * and hiding it would understate the day.
     */
    const earned = (s: string) => s !== 'CANCELLED';

    const since7 = istMidnightDaysAgo(6); // today plus the 6 before it
    const since30 = istMidnightDaysAgo(29);
    const { start: monthStart, end: monthEnd } = istMonthRange(month);

    let last7Paise = 0, last7Orders = 0;
    let last30Paise = 0, last30Orders = 0;
    let monthPaise = 0, monthOrders = 0;
    let allPaise = 0;

    // ---- the requested month, one entry per day --------------------
    const days = new Map<
      string,
      { date: string; orders: number; fulfilled: number; cancelled: number; pending: number; paise: number }
    >();
    const [my, mm] = month.split('-').map(Number) as [number, number];
    const daysInMonth = new Date(Date.UTC(my, mm, 0)).getUTCDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      days.set(date, { date, orders: 0, fulfilled: 0, cancelled: 0, pending: 0, paise: 0 });
    }

    for (const o of orders) {
      const paid = earned(o.status) ? o.totalPaise : 0;
      allPaise += paid;

      if (o.createdAt >= since7) { last7Paise += paid; last7Orders += 1; }
      if (o.createdAt >= since30) { last30Paise += paid; last30Orders += 1; }

      if (o.createdAt >= monthStart && o.createdAt < monthEnd) {
        monthPaise += paid;
        monthOrders += 1;
        const cell = days.get(istDay(o.createdAt));
        if (cell) {
          cell.orders += 1;
          cell[bucket(o.status)] += 1;
          cell.paise += paid;
        }
      }
    }

    /**
     * A dense 30-day series for the sparkline. Built from a pre-filled map
     * rather than from the orders, so quiet days exist as explicit zeroes.
     * Charting only the days that had orders draws a flat line through a
     * dead week and makes it look busy.
     */
    const series: Array<{ date: string; paise: number; orders: number }> = [];
    const seriesIdx = new Map<string, number>();
    for (let i = 29; i >= 0; i--) {
      const date = istDay(istMidnightDaysAgo(i));
      seriesIdx.set(date, series.length);
      series.push({ date, paise: 0, orders: 0 });
    }
    for (const o of orders) {
      if (o.createdAt < since30) continue;
      const at = seriesIdx.get(istDay(o.createdAt));
      if (at === undefined) continue;
      series[at]!.orders += 1;
      series[at]!.paise += earned(o.status) ? o.totalPaise : 0;
    }

    const [customers, skus] = await Promise.all([
      prisma.household.count({ where: { kiranaId } }),
      prisma.sku.count({ where: { kiranaId, active: true } }),
    ]);

    return {
      status,
      series,
      revenue: {
        last7Paise, last7Orders,
        last30Paise, last30Orders,
        monthPaise, monthOrders,
        allPaise, allOrders: orders.length,
      },
      month: { key: month, days: [...days.values()] },
      totals: { orders: orders.length, customers, skus },
      // so the client can bound its month stepper instead of guessing
      firstOrderDay: orders.length ? istDay(orders[0]!.createdAt) : null,
    };
  });

  /** Every order on one IST calendar day, for the calendar drill-down. */
  app.get('/analytics/day', async (req, reply) => {
    const { kiranaId } = requireSession(req);

    const parsed = daySchema.safeParse((req.query as { date?: string }).date);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'date must look like 2026-08-14' });
    }

    const start = new Date(Date.parse(`${parsed.data}T00:00:00Z`) - IST_OFFSET_MS);
    const end = new Date(start.getTime() + 86_400_000);

    const orders = await prisma.order.findMany({
      where: { kiranaId, createdAt: { gte: start, lt: end } },
      include: { household: true, _count: { select: { lines: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return {
      date: parsed.data,
      count: orders.length,
      totalPaise: orders.reduce((s, o) => s + (o.status === 'CANCELLED' ? 0 : o.totalPaise), 0),
      orders: orders.map((o) => ({
        id: o.id,
        household: o.household.name,
        status: o.status,
        source: o.source,
        totalPaise: o.totalPaise,
        items: o._count.lines,
        at: o.createdAt,
      })),
    };
  });
}
