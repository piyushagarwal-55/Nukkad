'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, rupees } from '@/lib/api';

/* ------------------------------------------------------------------ types */
interface Day {
  date: string; orders: number; fulfilled: number;
  cancelled: number; pending: number; paise: number;
}
interface Point { date: string; paise: number; orders: number }
interface Analytics {
  status: { fulfilled: number; cancelled: number; pending: number };
  series: Point[];
  revenue: {
    last7Paise: number; last7Orders: number;
    last30Paise: number; last30Orders: number;
    monthPaise: number; monthOrders: number;
    allPaise: number; allOrders: number;
  };
  month: { key: string; days: Day[] };
  totals: { orders: number; customers: number; skus: number };
  firstOrderDay: string | null;
}
interface DayDetail {
  date: string; count: number; totalPaise: number;
  orders: Array<{
    id: string; household: string; status: string; source: string;
    totalPaise: number; items: number; at: string;
  }>;
}

/* ---------------------------------------------------------------- helpers */
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const dayNum = (d: string) => Number(d.slice(-2));

function prettyDay(date: string, opts: Intl.DateTimeFormatOptions) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' });
}

/* ------------------------------------------------------------- sparkline */
/**
 * Sits inside the ink block and fills what would otherwise be dead space to
 * the right of the number. Hovering a column reports that day, which makes
 * the headline figure explorable rather than just asserted.
 */
function Spark({ points, onHover }: { points: Point[]; onHover: (p: Point | null) => void }) {
  const [on, setOn] = useState<string | null>(null);
  const peak = Math.max(1, ...points.map((p) => p.paise));

  return (
    <div
      className="flex h-[74px] items-end gap-[3px]"
      onMouseLeave={() => { setOn(null); onHover(null); }}
    >
      {points.map((p) => (
        <button
          key={p.date}
          className="spark-col group flex h-full flex-1 items-end"
          data-on={on === p.date}
          onMouseEnter={() => { setOn(p.date); onHover(p); }}
          aria-label={`${prettyDay(p.date, { day: 'numeric', month: 'short' })}: ${p.orders} orders`}
        >
          <span
            className="spark-bar w-full"
            style={{ height: `${Math.max(3, (p.paise / peak) * 100)}%` }}
          />
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- the donut */
const SEGMENTS = [
  { key: 'fulfilled' as const, label: 'Fulfilled', colour: 'var(--green)', note: 'delivered and done' },
  { key: 'pending' as const, label: 'Pending', colour: 'var(--amber)', note: 'agreed, not yet out' },
  { key: 'cancelled' as const, label: 'Cancelled', colour: 'var(--hot)', note: 'called off' },
];

function Donut({ status }: { status: Analytics['status'] }) {
  const [lit, setLit] = useState<string | null>(null);
  const total = status.fulfilled + status.pending + status.cancelled;

  const R = 66;
  const CIRC = 2 * Math.PI * R;

  let acc = 0; // running start angle, so each arc begins where the last ended
  const arcs = SEGMENTS.map((s) => {
    const value = status[s.key];
    const frac = total ? value / total : 0;
    const a = { ...s, value, frac, dash: frac * CIRC, offset: -acc * CIRC };
    acc += frac;
    return a;
  });
  const on = arcs.find((a) => a.key === lit);

  return (
    <div className="flex flex-col items-center gap-7 sm:flex-row sm:items-center">
      <div className="relative shrink-0">
        <svg viewBox="0 0 166 166" className="h-[172px] w-[172px] -rotate-90">
          <circle cx="83" cy="83" r={R} fill="none" stroke="#1a1a1a14" strokeWidth="26" />
          {arcs.filter((a) => a.value > 0).map((a, i) => (
            <circle
              key={a.key}
              className="donut-arc"
              cx="83" cy="83" r={R}
              fill="none"
              stroke={a.colour}
              strokeWidth="26"
              strokeDashoffset={a.offset}
              onMouseEnter={() => setLit(a.key)}
              onMouseLeave={() => setLit(null)}
              data-dim={lit !== null && lit !== a.key}
              data-on={lit === a.key}
              style={{
                '--circ': CIRC,
                '--dash': a.dash,
                animationDelay: `${i * 0.13}s`,
                strokeDasharray: `${a.dash} ${CIRC}`,
              } as React.CSSProperties}
            />
          ))}
        </svg>

        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <p className="display text-[36px] leading-none">{on ? on.value : total}</p>
            <p className="muted mt-1 text-[11px]">{on ? on.label.toLowerCase() : 'orders'}</p>
          </div>
        </div>
      </div>

      <ul className="w-full flex-1 space-y-1">
        {arcs.map((a) => (
          <li
            key={a.key}
            className="legend-row flex items-center gap-3 px-2.5 py-2"
            data-on={lit === a.key}
            onMouseEnter={() => setLit(a.key)}
            onMouseLeave={() => setLit(null)}
          >
            <span
              className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-[var(--ink)]"
              style={{ background: a.colour }}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{a.label}</span>
              <span className="muted block text-[11px]">{a.note}</span>
            </span>
            <span className="text-right">
              <span className="block text-sm tabular-nums">{a.value}</span>
              <span className="muted block text-[11px] tabular-nums">
                {total ? Math.round(a.frac * 100) : 0}%
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------- the calendar */
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function shiftMonth(key: string, by: number) {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function Calendar({
  month, days, selected, onSelect, onMonth,
}: {
  month: string; days: Day[]; selected: string | null;
  onSelect: (d: string) => void; onMonth: (m: string) => void;
}) {
  const today = istToday();
  const busiest = Math.max(1, ...days.map((d) => d.orders));
  const [y, m] = month.split('-').map(Number) as [number, number];
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const tone = (n: number) => (n === 0 ? '' : `cal-i${Math.min(4, Math.ceil((n / busiest) * 4))}`);

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h2 className="display text-xl">
          {prettyDay(`${month}-01`, { month: 'long', year: 'numeric' })}
        </h2>
        <div className="flex gap-1.5">
          {[-1, 1].map((by) => (
            <button
              key={by}
              onClick={() => onMonth(shiftMonth(month, by))}
              aria-label={by < 0 ? 'Previous month' : 'Next month'}
              className="grid h-7 w-7 place-items-center rounded-lg border-2 border-[var(--ink)] text-xs transition-colors hover:bg-[var(--accent)]"
            >
              {by < 0 ? '←' : '→'}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="muted pb-1 text-center text-[10px] font-semibold">{w}</div>
        ))}
        {Array.from({ length: lead }, (_, i) => <div key={`l${i}`} />)}
        {days.map((d) => {
          const has = d.orders > 0;
          return (
            <button
              key={d.date}
              disabled={!has}
              onClick={() => onSelect(d.date)}
              data-has={has}
              data-sel={selected === d.date}
              data-today={d.date === today}
              title={has ? `${d.orders} orders · ₹${rupees(d.paise)}` : undefined}
              className={`cal-cell flex flex-col items-center justify-center ${tone(d.orders)} ${has ? '' : 'cursor-default'}`}
            >
              <span className={`text-[11px] ${has ? 'font-bold' : 'text-[var(--faint)]'}`}>
                {dayNum(d.date)}
              </span>
              {has && <span className="text-[9px] font-medium tabular-nums">{d.orders}</span>}
            </button>
          );
        })}
      </div>

      <p className="muted mt-4 flex flex-wrap items-center gap-1.5 text-[10px]">
        Quiet
        {['cal-i1', 'cal-i2', 'cal-i3', 'cal-i4'].map((c) => (
          <span key={c} className={`${c} h-3 w-3 rounded border border-[var(--ink)]`} />
        ))}
        Busy &middot; tap a day
      </p>
    </>
  );
}

/* -------------------------------------------------------------- the page */
const WINDOWS = [
  { key: 'last7' as const, label: '7d' },
  { key: 'last30' as const, label: '30d' },
  { key: 'month' as const, label: 'Month' },
  { key: 'all' as const, label: 'All' },
];

export default function Overview() {
  const [month, setMonth] = useState(() => istToday().slice(0, 7));
  const [a, setA] = useState<Analytics | null>(null);
  const [win, setWin] = useState<(typeof WINDOWS)[number]['key']>('month');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DayDetail | null>(null);
  const [peek, setPeek] = useState<Point | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    get<Analytics>(`/analytics?month=${month}`).then(setA).catch((e) => setErr(e.message));
  }, [month]);

  const pick = useCallback((d: string) => {
    setSelected(d);
    setDetail(null);
    get<DayDetail>(`/analytics/day?date=${d}`).then(setDetail).catch((e) => setErr(e.message));
  }, []);

  const shown = useMemo(() => {
    if (!a) return { paise: 0, orders: 0 };
    const r = a.revenue;
    return {
      last7: { paise: r.last7Paise, orders: r.last7Orders },
      last30: { paise: r.last30Paise, orders: r.last30Orders },
      month: { paise: r.monthPaise, orders: r.monthOrders },
      all: { paise: r.allPaise, orders: r.allOrders },
    }[win];
  }, [a, win]);

  if (err) return <p className="text-[var(--warn)]">{err}</p>;
  if (!a) return <p className="muted text-sm">Loading…</p>;

  const avg = shown.orders ? Math.round(shown.paise / shown.orders) : 0;
  const spark = win === 'last7' ? a.series.slice(-7) : a.series;

  return (
    <>
      <h1 className="display text-[clamp(2rem,4vw,2.75rem)]">Overview</h1>
      <p className="muted mt-2 text-sm">Everything the shop has done, and what it is owed.</p>

      {/* ---- revenue. Full ink, so the page opens on a colour, not an outline. */}
      <section className="pane-ink card-in mt-7 p-7 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <p className="text-[13px] text-[var(--bg)]/60">
            {peek ? prettyDay(peek.date, { weekday: 'long', day: 'numeric', month: 'long' }) : 'Revenue'}
          </p>
          <div className="seg-pill flex">
            {WINDOWS.map((w) => (
              <button key={w.key} onClick={() => setWin(w.key)} data-on={win === w.key} className="seg-btn">
                {w.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
          <div className="min-w-[190px]">
            <p className="display text-[clamp(2.75rem,7vw,4.25rem)] leading-none text-[var(--bg)]">
              &#8377;{rupees(peek ? peek.paise : shown.paise)}
            </p>
            <p className="mt-3 text-sm text-[var(--bg)]/55">
              {peek ? (
                <>{peek.orders} order{peek.orders === 1 ? '' : 's'} that day</>
              ) : (
                <>
                  {shown.orders} order{shown.orders === 1 ? '' : 's'}
                  {avg > 0 && <> &middot; &#8377;{rupees(avg)} average</>}
                </>
              )}
            </p>
          </div>

          <div className="min-w-[220px] flex-1">
            <Spark points={spark} onHover={setPeek} />
            <p className="mt-2 text-[10px] text-[var(--bg)]/35">
              {spark.length} days to today &middot; hover a bar
            </p>
          </div>
        </div>

        <p className="mt-7 border-t border-[var(--bg)]/15 pt-4 text-xs leading-relaxed text-[var(--bg)]/45">
          Cancelled orders are excluded. Pending ones are counted, because that
          is money the shop is owed rather than money it never made.
        </p>
      </section>

      {/* ---- three flat colour tiles, no white boxes ---- */}
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        {[
          { label: 'Orders, all time', value: a.totals.orders, cls: 'tile-1' },
          { label: 'Customers', value: a.totals.customers, cls: 'tile-2' },
          { label: 'Items in catalogue', value: a.totals.skus, cls: 'tile-3' },
        ].map((s, i) => (
          <div
            key={s.label}
            className={`tile card-in ${s.cls} p-5`}
            style={{ animationDelay: `${80 + i * 70}ms` }}
          >
            <p className="display text-[34px] leading-none">{s.value}</p>
            <p className="mt-1.5 text-[13px] font-medium">{s.label}</p>
          </div>
        ))}
      </div>

      {/* ---- donut and calendar side by side, so the page stops stacking ---- */}
      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1.05fr]">
        <section className="pane card-in p-6" style={{ animationDelay: '280ms' }}>
          <h2 className="display text-xl">Where orders stand</h2>
          <p className="muted mt-1 mb-6 text-[13px]">Hover a slice.</p>
          <Donut status={a.status} />
        </section>

        <section className="pane card-in p-6" style={{ animationDelay: '340ms' }}>
          <Calendar
            month={month}
            days={a.month.days}
            selected={selected}
            onSelect={pick}
            onMonth={(m) => { setMonth(m); setSelected(null); setDetail(null); }}
          />
        </section>
      </div>

      {/* ---- the day drilldown, full width under both ---- */}
      {selected && (
        <section className="pane card-in mt-5 bg-[var(--panel)] p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h3 className="display text-xl">
              {prettyDay(selected, { weekday: 'long', day: 'numeric', month: 'long' })}
            </h3>
            <button
              onClick={() => { setSelected(null); setDetail(null); }}
              className="muted text-xs hover:text-[var(--hot)]"
            >
              Close
            </button>
          </div>

          {!detail ? (
            <p className="muted mt-4 text-sm">Loading…</p>
          ) : (
            <>
              <p className="display mt-3 text-[40px] leading-none">
                &#8377;{rupees(detail.totalPaise)}
              </p>
              <p className="muted mt-1.5 text-sm">
                from {detail.count} order{detail.count === 1 ? '' : 's'}
              </p>

              <ul className="mt-5 divide-y divide-[var(--line)] border-t border-[var(--line)]">
                {detail.orders.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm">
                    <span className="font-medium">{o.household}</span>
                    <span className="muted text-xs">
                      {o.items} item{o.items === 1 ? '' : 's'} &middot;{' '}
                      {new Date(o.at).toLocaleTimeString('en-IN', {
                        hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
                      })}
                    </span>
                    <span
                      className="rounded-full border border-[var(--ink)] px-2 py-0.5 text-[10px] font-semibold"
                      style={{
                        background:
                          o.status === 'FULFILLED' ? 'var(--green)'
                          : o.status === 'CANCELLED' ? 'var(--hot)'
                          : 'var(--amber)',
                        color: o.status === 'FULFILLED' ? 'var(--panel)' : 'var(--ink)',
                      }}
                    >
                      {o.status.toLowerCase()}
                    </span>
                    <span className="ml-auto tabular-nums">&#8377;{rupees(o.totalPaise)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </>
  );
}
