'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { get, rupees } from '@/lib/api';
import { RowsSkeleton } from '@/components/Loading';

/**
 * The audit surface.
 *
 * Every other screen shows what the shop HAS. This one shows how it got
 * there: the words a customer actually said, what those words were matched
 * to, and by which route. A resolver nobody can inspect is a resolver
 * nobody should let write a price, so the transcript and the method are
 * the point of the page rather than a footnote on it.
 */

interface Line {
  name: string;
  quantity: number;
  linePaise: number;
  method: string;
  confidence: number;
  wasSubstituted: boolean;
  sourceText: string;
}
interface Order {
  id: string;
  household: string;
  status: string;
  source: string;
  totalPaise: number;
  createdAt: string;
  transcript: string | null;
  latencyMs: number | null;
  lines: Line[];
  outstandingPaise: number;
}

/**
 * What each matching route means, in words an owner would use.
 *
 * These are the same routes the ablation ladder measures, so the page and
 * the accuracy claim are describing one mechanism rather than two.
 */
const METHOD: Record<string, { cls: string; label: string; why: string }> = {
  EXACT: { cls: 'm-exact', label: 'exact', why: 'the name matched a product outright' },
  FUZZY: { cls: 'm-fuzzy', label: 'spelling', why: 'spelled differently, same product' },
  PRIOR: { cls: 'm-prior', label: 'their usual', why: 'chosen from what this household always buys' },
  EMBEDDING: { cls: 'm-fuzzy', label: 'meaning', why: 'matched on meaning rather than spelling' },
  LLM: { cls: 'm-llm', label: 'judged', why: 'sent to the adjudicator to decide' },
  DISAMBIGUATED: { cls: 'm-llm', label: 'you chose', why: 'the customer picked from options we offered' },
  SUBSTITUTED: { cls: 'm-substituted', label: 'swapped', why: 'first choice was out of stock' },
  UNRESOLVED: { cls: 'm-unresolved', label: 'not matched', why: 'nothing in the catalogue fit' },
};

const STATUS: Record<string, string> = {
  FULFILLED: 'ost-fulfilled', CONFIRMED: 'ost-confirmed',
  // checkout writes PAYMENT_PENDING, never AWAITING -- see writeOrder(). The
  // old map had only AWAITING, so every unpaid order rendered as a draft.
  PAYMENT_PENDING: 'ost-awaiting', AWAITING: 'ost-awaiting',
  CANCELLED: 'ost-cancelled', DRAFT: 'ost-draft',
};

/** what a status is called out loud, since PAYMENT_PENDING is not a phrase */
const STATUS_LABEL: Record<string, string> = {
  PAYMENT_PENDING: 'payment pending',
};

const SOURCE: Record<string, string> = {
  VOICE: 'said out loud', TEXT: 'typed on WhatsApp', PHOTO: 'sent a photo',
  AUTO: 'placed by the agent', MENU: 'tapped the menu',
};

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'PAYMENT_PENDING', label: 'Waiting on them' },
  { key: 'CONFIRMED', label: 'Confirmed' },
  { key: 'FULFILLED', label: 'Fulfilled' },
  { key: 'owed', label: 'Money owed' },
] as const;

function when(iso: string) {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  if (days === 0) return `today, ${time}`;
  if (days === 1) return `yesterday, ${time}`;
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}

/* ------------------------------------------------------- one order row */
/**
 * A link, not an accordion.
 *
 * The interesting parts of an order -- how it was matched, what it earned,
 * where it lost money -- do not fit under a row without burying them, and
 * an expanded row cannot be linked to, reloaded or sent to anybody. The
 * summary earns its place here; everything else lives on its own page.
 */
function OrderRow({ o }: { o: Order }) {
  const st = STATUS[o.status] ?? 'ost-draft';
  const weak = o.lines.filter((l) => l.method === 'UNRESOLVED' || l.confidence < 0.55).length;
  const swapped = o.lines.filter((l) => l.wasSubstituted).length;

  return (
    <Link href={`/dashboard/orders/${o.id}`} className="inv-row block px-3 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="font-medium">{o.household}</span>
            <span className={`ost ${st}`}>{STATUS_LABEL[o.status] ?? o.status.toLowerCase()}</span>
          </p>
          <p className="muted mt-0.5 text-xs">
            {when(o.createdAt)} &middot; {SOURCE[o.source] ?? o.source.toLowerCase()} &middot;{' '}
            {o.lines.length} item{o.lines.length === 1 ? '' : 's'}
            {o.latencyMs ? <> &middot; understood in {(o.latencyMs / 1000).toFixed(1)}s</> : null}
          </p>

          {o.transcript && (
            <p className="muted mt-1.5 truncate text-[13px] italic">
              &ldquo;{o.transcript}&rdquo;
            </p>
          )}

          {(weak > 0 || swapped > 0) && (
            <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11px]">
              {weak > 0 && (
                <span className="text-[var(--warn)]">
                  {weak} unsure line{weak === 1 ? '' : 's'}
                </span>
              )}
              {swapped > 0 && (
                <span className="muted">
                  {swapped} swapped for stock
                </span>
              )}
            </p>
          )}
        </div>

        <div className="shrink-0 text-right">
          <p className="tabular-nums">&#8377;{rupees(o.totalPaise)}</p>
          {o.outstandingPaise > 0 ? (
            <p className="text-xs font-semibold text-[var(--warn)] tabular-nums">
              &#8377;{rupees(o.outstandingPaise)} owed
            </p>
          ) : (
            <p className="muted text-xs">settled</p>
          )}
          <p className="muted mt-1 text-xs">details &rarr;</p>
        </div>
      </div>
    </Link>
  );
}

/* -------------------------------------------------------------- page */
export default function Orders() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('all');
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    get<{ orders: Order[] }>('/orders')
      .then((d) => setOrders(d.orders))
      .catch((e) => setErr(e.message));
  }, []);

  const stats = useMemo(() => {
    const o = orders ?? [];
    return {
      total: o.length,
      owed: o.reduce((n, x) => n + x.outstandingPaise, 0),
      awaiting: o.filter((x) => x.status === 'PAYMENT_PENDING' || x.status === 'AWAITING').length,
      voice: o.filter((x) => x.source === 'VOICE').length,
    };
  }, [orders]);

  const shown = useMemo(() => {
    let list = orders ?? [];
    if (tab === 'owed') list = list.filter((o) => o.outstandingPaise > 0);
    else if (tab !== 'all') list = list.filter((o) => o.status === tab);
    if (q.trim()) {
      const n = q.toLowerCase();
      list = list.filter((o) =>
        `${o.household} ${o.transcript ?? ''} ${o.lines.map((l) => l.name).join(' ')}`
          .toLowerCase()
          .includes(n),
      );
    }
    return list;
  }, [orders, tab, q]);

  if (err) return <p className="text-[var(--warn)]">{err}</p>;
  if (!orders) return <RowsSkeleton rows={8} />;

  return (
    <>
      <h1 className="display text-[clamp(2rem,4vw,2.75rem)]">Orders</h1>
      <p className="muted mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span>{stats.total} orders</span>
        {stats.awaiting > 0 && <span>{stats.awaiting} waiting on the customer</span>}
        {stats.owed > 0 && (
          <span className="text-[var(--warn)]">&#8377;{rupees(stats.owed)} outstanding</span>
        )}
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2.5">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} data-on={tab === t.key} className="inv-tab">
            {t.label}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a customer, a word they said, an item"
          className="inv-field ml-auto !w-auto min-w-[240px] flex-1 sm:flex-none"
        />
      </div>

      {orders.length === 0 ? (
        <div className="pane mt-6 p-10 text-center">
          <h2 className="display text-2xl">No orders yet</h2>
          <p className="muted mx-auto mt-3 max-w-md text-sm leading-relaxed">
            Once a customer is registered and messages the shop, everything they
            say and everything the shop makes of it shows up here.
          </p>
        </div>
      ) : (
        <div className="pane mt-4 p-2">
          <div className="divide-y divide-[#1a1a1a12]">
            {shown.map((o) => (
              <OrderRow key={o.id} o={o} />
            ))}
          </div>
          {shown.length === 0 && (
            <p className="muted px-3 py-10 text-center text-sm">Nothing matches that.</p>
          )}
        </div>
      )}

      <p className="muted mt-4 text-xs leading-relaxed">
        Open an order to see how every line was matched, what it earned, and
        where the shelf price has fallen behind what the supplier charges.
      </p>
    </>
  );
}
