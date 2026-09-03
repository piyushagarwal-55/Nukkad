'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { get, rupees } from '@/lib/api';
import { Skel, useDelayed } from '@/components/Loading';

/**
 * One order, explained.
 *
 * The list says what happened. This says whether it was any good: how each
 * line was matched and how sure of it, what the shop actually made, and
 * where it lost money. The margin panel is the one an owner will look at
 * first, so it is the one at the top.
 */

interface Line {
  id: string;
  name: string;
  sourceText: string;
  quantity: number;
  unitPricePaise: number;
  linePaise: number;
  costPaise: number | null;
  marginPaise: number | null;
  method: string;
  confidence: number;
  wasSubstituted: boolean;
  substitutedFrom: string | null;
}
interface Detail {
  id: string;
  status: string;
  source: string;
  totalPaise: number;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  transcript: string | null;
  asrEngine: string | null;
  latencyMs: number | null;
  household: {
    name: string; phone: string; memberCount: number;
    autonomyTier: string; streak: number;
    orderCount: number; avgPaise: number | null; previousAt: string | null;
  };
  lines: Line[];
  margin: {
    knownLines: number; totalLines: number;
    costPaise: number; revenuePaise: number; marginPaise: number;
  };
  invoice: {
    status: string; amountPaise: number; amountPaidPaise: number;
    shortUrl: string | null; acceptPartial: boolean;
    payments: Array<{ amountPaise: number; method: string | null; status: string; at: string }>;
  } | null;
}

const METHOD: Record<string, { cls: string; label: string; colour: string }> = {
  EXACT: { cls: 'm-exact', label: 'exact', colour: 'var(--green)' },
  FUZZY: { cls: 'm-fuzzy', label: 'spelling', colour: 'var(--accent)' },
  PRIOR: { cls: 'm-prior', label: 'their usual', colour: 'var(--pink)' },
  EMBEDDING: { cls: 'm-fuzzy', label: 'meaning', colour: 'var(--accent)' },
  LLM: { cls: 'm-llm', label: 'judged', colour: 'var(--sand)' },
  DISAMBIGUATED: { cls: 'm-llm', label: 'they chose', colour: 'var(--sand)' },
  SUBSTITUTED: { cls: 'm-substituted', label: 'swapped', colour: 'var(--amber)' },
  UNRESOLVED: { cls: 'm-unresolved', label: 'not matched', colour: 'var(--hot)' },
};
const STATUS: Record<string, string> = {
  FULFILLED: 'ost-fulfilled', CONFIRMED: 'ost-confirmed',
  // checkout writes PAYMENT_PENDING, never AWAITING. Without this row an
  // unpaid order was styled as a draft on its own detail page.
  PAYMENT_PENDING: 'ost-awaiting', AWAITING: 'ost-awaiting',
  CANCELLED: 'ost-cancelled', DRAFT: 'ost-draft',
};
const SOURCE: Record<string, string> = {
  VOICE: 'said out loud', TEXT: 'typed on WhatsApp', PHOTO: 'sent a photo',
  AUTO: 'placed by the agent', MENU: 'tapped the menu',
};

const dt = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

/* ----------------------------------------------------------- the donut */
/**
 * How this order was resolved, by route.
 *
 * Same shape as the one on Overview on purpose: an owner should not have
 * to learn a second chart to read the same kind of fact.
 */
function MethodDonut({ lines }: { lines: Line[] }) {
  const [lit, setLit] = useState<string | null>(null);

  const groups = new Map<string, number>();
  for (const l of lines) groups.set(l.method, (groups.get(l.method) ?? 0) + 1);

  const R = 54;
  const CIRC = 2 * Math.PI * R;
  let acc = 0;

  const arcs = [...groups.entries()].map(([method, count]) => {
    const frac = count / lines.length;
    const a = {
      method, count, frac,
      dash: frac * CIRC,
      offset: -acc * CIRC,
      ...(METHOD[method] ?? { cls: 'm-llm', label: method.toLowerCase(), colour: 'var(--sand)' }),
    };
    acc += frac;
    return a;
  });

  const on = arcs.find((a) => a.method === lit);

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative shrink-0">
        <svg viewBox="0 0 140 140" className="h-[140px] w-[140px] -rotate-90">
          <circle cx="70" cy="70" r={R} fill="none" stroke="#1a1a1a14" strokeWidth="22" />
          {arcs.map((a, i) => (
            <circle
              key={a.method}
              className="donut-arc"
              cx="70" cy="70" r={R}
              fill="none"
              stroke={a.colour}
              strokeWidth="22"
              strokeDashoffset={a.offset}
              onMouseEnter={() => setLit(a.method)}
              onMouseLeave={() => setLit(null)}
              data-dim={lit !== null && lit !== a.method}
              style={{
                '--circ': CIRC, '--dash': a.dash,
                animationDelay: `${i * 0.12}s`,
                strokeDasharray: `${a.dash} ${CIRC}`,
              } as React.CSSProperties}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <p className="display text-[28px] leading-none">{on ? on.count : lines.length}</p>
            <p className="muted text-[10px]">{on ? on.label : 'lines'}</p>
          </div>
        </div>
      </div>

      <ul className="min-w-[150px] flex-1 space-y-1.5">
        {arcs.map((a) => (
          <li
            key={a.method}
            onMouseEnter={() => setLit(a.method)}
            onMouseLeave={() => setLit(null)}
            className="flex cursor-default items-center gap-2.5 text-sm"
          >
            <span
              className="h-3 w-3 shrink-0 rounded-full border-2 border-[var(--ink)]"
              style={{ background: a.colour }}
            />
            <span className="flex-1">{a.label}</span>
            <span className="tabular-nums">{a.count}</span>
            <span className="muted w-10 text-right text-xs tabular-nums">
              {Math.round(a.frac * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------- what made up the total */
function ValueBars({ lines, total }: { lines: Line[]; total: number }) {
  const sorted = [...lines].sort((a, b) => b.linePaise - a.linePaise);
  const top = sorted[0]?.linePaise || 1;

  return (
    <ul className="space-y-3">
      {sorted.map((l) => {
        const share = total ? l.linePaise / total : 0;
        const loss = l.marginPaise !== null && l.marginPaise < 0;
        return (
          <li key={l.id}>
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate">{l.name}</span>
              <span className="shrink-0 tabular-nums">
                &#8377;{rupees(l.linePaise)}
                <span className="muted ml-1.5 text-[11px]">{Math.round(share * 100)}%</span>
              </span>
            </div>
            <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-[#1a1a1a12]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(2, (l.linePaise / top) * 100)}%`,
                  background: loss ? 'var(--hot)' : 'var(--ink)',
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------- page */
export default function OrderDetail() {
  const { orderId } = useParams<{ orderId: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const slow = useDelayed(240);

  useEffect(() => {
    get<Detail>(`/orders/${orderId}`).then(setD).catch((e) => setErr(e.message));
  }, [orderId]);

  if (err) {
    return (
      <>
        <Link href="/dashboard/orders" className="muted text-sm hover:text-[var(--hot)]">
          &larr; All orders
        </Link>
        <p className="mt-4 text-[var(--warn)]">{err}</p>
      </>
    );
  }

  if (!d) {
    return slow ? (
      <div className="load-in">
        <Skel className="h-9 w-56" />
        <Skel className="mt-3 h-4 w-72" />
        <div className="pane-ink mt-7 p-7"><Skel className="h-16 w-52" inverted /></div>
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <div className="pane p-6"><Skel className="h-[140px] w-full" /></div>
          <div className="pane p-6"><Skel className="h-[140px] w-full" /></div>
        </div>
      </div>
    ) : null;
  }

  const m = d.margin;
  const marginPct = m.revenuePaise ? (m.marginPaise / m.revenuePaise) * 100 : 0;
  const lossy = d.lines.filter((l) => l.marginPaise !== null && l.marginPaise < 0);
  const weak = d.lines.filter((l) => l.confidence < 0.55 || l.method === 'UNRESOLVED');
  const vsAvg = d.household.avgPaise ? d.totalPaise - d.household.avgPaise : null;
  const outstanding = d.invoice ? d.invoice.amountPaise - d.invoice.amountPaidPaise : 0;

  return (
    <>
      <Link href="/dashboard/orders" className="muted text-sm hover:text-[var(--hot)]">
        &larr; All orders
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="display text-[clamp(1.9rem,4vw,2.6rem)]">{d.household.name}</h1>
          <p className="muted mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className={`ost ${STATUS[d.status] ?? 'ost-draft'}`}>{d.status.toLowerCase()}</span>
            <span>{dt(d.createdAt)}</span>
            <span>{SOURCE[d.source] ?? d.source.toLowerCase()}</span>
            {d.latencyMs ? <span>understood in {(d.latencyMs / 1000).toFixed(1)}s</span> : null}
          </p>
        </div>
        <div className="text-right">
          <p className="display text-[clamp(2rem,5vw,2.75rem)] leading-none">
            &#8377;{rupees(d.totalPaise)}
          </p>
          {vsAvg !== null && (
            <p className="muted mt-1.5 text-xs">
              {vsAvg === 0 ? 'exactly their usual' : (
                <>
                  {vsAvg > 0 ? '▲' : '▼'} &#8377;{rupees(Math.abs(vsAvg))} vs their average
                </>
              )}
            </p>
          )}
        </div>
      </div>

      {/* ---- what the shop made on it ---- */}
      <section className="pane-ink card-in mt-6 p-7">
        <p className="text-[13px] text-[var(--bg)]/60">What this order earned</p>
        <div className="mt-3 flex flex-wrap items-end gap-x-10 gap-y-5">
          <div>
            <p className="display text-[clamp(2.25rem,6vw,3.25rem)] leading-none text-[var(--bg)]">
              &#8377;{rupees(m.marginPaise)}
            </p>
            <p className="mt-2 text-sm text-[var(--bg)]/55">
              {marginPct.toFixed(1)}% on &#8377;{rupees(m.revenuePaise)} of goods
            </p>
          </div>

          {/* cost against sale, as one bar */}
          <div className="min-w-[220px] flex-1">
            <div className="flex h-7 overflow-hidden rounded-lg border border-[var(--bg)]/25">
              <div
                className="grid place-items-center bg-[var(--bg)]/25 text-[11px] text-[var(--bg)]"
                style={{ width: `${Math.max(6, (m.costPaise / Math.max(m.revenuePaise, 1)) * 100)}%` }}
              >
                cost
              </div>
              <div className="grid flex-1 place-items-center bg-[var(--green)] text-[11px] font-semibold text-[var(--panel)]">
                margin
              </div>
            </div>
            <p className="mt-2 text-[11px] text-[var(--bg)]/45">
              &#8377;{rupees(m.costPaise)} paid to the supplier &middot; &#8377;{rupees(m.revenuePaise)} charged
            </p>
          </div>
        </div>

        {m.knownLines < m.totalLines && (
          <p className="mt-5 border-t border-[var(--bg)]/15 pt-4 text-xs text-[var(--bg)]/45">
            Based on {m.knownLines} of {m.totalLines} lines. The rest have no cost
            price yet, which arrives with the next supplier bill for them.
          </p>
        )}
      </section>

      {/* ---- anything worth acting on ---- */}
      {(lossy.length > 0 || weak.length > 0) && (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {lossy.length > 0 && (
            <div className="tile tile-3 p-5">
              <p className="display text-[28px] leading-none">{lossy.length}</p>
              <p className="mt-1.5 text-[13px] font-medium">
                line{lossy.length === 1 ? '' : 's'} sold below cost
              </p>
              <p className="mt-2 text-[12px] leading-relaxed">
                {lossy.map((l) => l.name).join(', ')} — the supplier price moved
                and the shelf price has not caught up.
              </p>
            </div>
          )}
          {weak.length > 0 && (
            <div className="tile tile-2 p-5">
              <p className="display text-[28px] leading-none">{weak.length}</p>
              <p className="mt-1.5 text-[13px] font-medium">
                line{weak.length === 1 ? '' : 's'} matched with low confidence
              </p>
              <p className="mt-2 text-[12px] leading-relaxed">
                Worth checking the customer got what they meant.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ---- the two charts ---- */}
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section className="pane card-in p-6">
          <h2 className="display text-xl">How it was understood</h2>
          <p className="muted mt-1 mb-5 text-[13px]">
            Which route matched each line. Hover a slice.
          </p>
          <MethodDonut lines={d.lines} />
        </section>

        <section className="pane card-in p-6">
          <h2 className="display text-xl">What made up the total</h2>
          <p className="muted mt-1 mb-5 text-[13px]">
            Coral means that line was sold below what it cost.
          </p>
          <ValueBars lines={d.lines} total={d.totalPaise} />
        </section>
      </div>

      {/* ---- the words, and what became of them ---- */}
      <section className="pane card-in mt-5 p-6">
        {d.transcript && (
          <>
            <p className="muted text-[11px] font-semibold">What they said</p>
            <p className="said display mt-2 text-[19px] leading-snug">
              &ldquo;{d.transcript}&rdquo;
            </p>
            {d.asrEngine && (
              <p className="muted mt-2 text-[11px]">transcribed by {d.asrEngine}</p>
            )}
          </>
        )}

        <p className="muted mt-6 text-[11px] font-semibold">Line by line</p>
        <ul className="mt-2 divide-y divide-[#1a1a1a12]">
          {d.lines.map((l) => {
            const meth = METHOD[l.method] ?? { cls: 'm-llm', label: l.method.toLowerCase(), colour: 'var(--sand)' };
            const loss = l.marginPaise !== null && l.marginPaise < 0;
            return (
              <li key={l.id} className="py-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="muted text-[13px] italic">&ldquo;{l.sourceText}&rdquo;</span>
                  <span className="became">&rarr;</span>
                  <span className="text-[13px] font-medium">{l.quantity} &times; {l.name}</span>
                  <span className={`method ${meth.cls}`}>{meth.label}</span>
                  {l.substitutedFrom && (
                    <span className="muted text-[11px]">instead of {l.substitutedFrom}</span>
                  )}
                  <span className="ml-auto text-[13px] tabular-nums">&#8377;{rupees(l.linePaise)}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="conf-rail w-14 shrink-0">
                    <span
                      className="conf-fill block"
                      style={{
                        width: `${Math.round(l.confidence * 100)}%`,
                        background: l.confidence < 0.55 ? 'var(--hot)' : 'var(--ink)',
                      }}
                    />
                  </span>
                  <span className="muted text-[11px]">
                    &#8377;{rupees(l.unitPricePaise)} each
                    {l.costPaise !== null && (
                      <>
                        {' '}&middot; cost &#8377;{rupees(l.costPaise)} &middot;{' '}
                        <span className={loss ? 'delta-up' : 'delta-down'}>
                          {loss ? 'loss' : 'margin'} &#8377;{rupees(Math.abs(l.marginPaise ?? 0))}
                        </span>
                      </>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ---- money and the customer ---- */}
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <section className="pane card-in p-6">
          <h2 className="display text-xl">Payment</h2>
          {!d.invoice ? (
            <p className="muted mt-3 text-sm leading-relaxed">
              No bill has gone out for this order yet.
            </p>
          ) : (
            <>
              <p className="muted mt-3 text-sm">
                {d.invoice.status.toLowerCase().replace('_', ' ')}
                {d.invoice.acceptPartial && ' · part payment allowed'}
              </p>
              <p className="display mt-3 text-[32px] leading-none">
                &#8377;{rupees(d.invoice.amountPaidPaise)}
                <span className="muted text-base"> of &#8377;{rupees(d.invoice.amountPaise)}</span>
              </p>
              {outstanding > 0 && (
                <p className="mt-2 text-sm font-semibold text-[var(--warn)]">
                  &#8377;{rupees(outstanding)} still owed
                </p>
              )}
              {d.invoice.payments.length > 0 && (
                <ul className="muted mt-4 space-y-1 border-t border-[var(--line)] pt-3 text-xs">
                  {d.invoice.payments.map((p, i) => (
                    <li key={i}>
                      &#8377;{rupees(p.amountPaise)} {p.method ?? ''} &middot; {dt(p.at)}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        <section className="pane card-in p-6">
          <h2 className="display text-xl">The customer</h2>
          <p className="muted mt-3 text-sm">{d.household.phone} &middot; {d.household.memberCount} people</p>
          <div className="mt-4 space-y-2 text-sm">
            <p className="flex justify-between">
              <span className="muted">Orders placed</span>
              <span className="tabular-nums">{d.household.orderCount}</span>
            </p>
            {d.household.avgPaise !== null && (
              <p className="flex justify-between">
                <span className="muted">Their usual size</span>
                <span className="tabular-nums">&#8377;{rupees(d.household.avgPaise)}</span>
              </p>
            )}
            <p className="flex justify-between">
              <span className="muted">Agent may</span>
              <span className="text-right">
                {d.household.autonomyTier === 'MANUAL' && 'wait to be asked'}
                {d.household.autonomyTier === 'SUGGESTED' && 'propose, they confirm'}
                {d.household.autonomyTier === 'STANDING' && 'order, they may veto'}
                {d.household.autonomyTier === 'SILENT' && 'order under a cap'}
              </span>
            </p>
            {d.household.previousAt && (
              <p className="flex justify-between">
                <span className="muted">Previous order</span>
                <span>{dt(d.household.previousAt)}</span>
              </p>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
