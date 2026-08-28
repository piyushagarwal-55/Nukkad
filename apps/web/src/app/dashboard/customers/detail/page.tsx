'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { get, rupees } from '@/lib/api';

/**
 * ONE CUSTOMER, IN FULL. Every claim on this page traces to a row:
 * the pattern line is a median over their own order gaps, the frequent
 * list is their own order lines, the timeline is the AgentEvent spine,
 * and the opportunity is a category arithmetic -- never a model's guess
 * about a person.
 */

interface Detail {
  customer: {
    id: string; name: string; phone: string; address: string | null; since: string;
    orders: number; spendPaise: number; avgBasketPaise: number;
    medianGapDays: number | null; daysSinceLast: number | null;
  };
  frequent: Array<{ name: string; times: number; units: number }>;
  recentOrders: Array<{ id: string; createdAt: string; totalPaise: number; status: string }>;
  timeline: Array<{
    id: string; createdAt: string; desk: string; act: string | null;
    heard: string; reply: string | null; handoffFrom: string | null; handoffTo: string | null;
    channel: string; latencyMs: number;
  }>;
  opportunity: string | null;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

function CustomerDetail() {
  const id = useSearchParams().get('householdId') ?? '';
  const [data, setData] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    get<Detail>(`/intel/customer/detail?householdId=${encodeURIComponent(id)}`)
      .then(setData)
      .catch(() => setErr('Customer detail load nahi hui.'));
  }, [id]);

  if (!id) return <p className="muted mt-8 text-sm">Koi customer select nahi hua.</p>;
  if (err) return <p className="muted mt-8 text-sm">{err}</p>;
  if (!data) return <p className="muted mt-8 text-sm">Loading…</p>;

  const c = data.customer;
  const due =
    c.medianGapDays !== null && c.daysSinceLast !== null && c.daysSinceLast > c.medianGapDays * 1.25;

  return (
    <>
      <Link href="/dashboard/customers" className="muted text-sm">← Customers</Link>
      <h1 className="display mt-2 text-[clamp(1.8rem,4vw,2.5rem)]">{c.name}</h1>
      <p className="muted mt-2 text-sm tabular-nums">
        {c.phone}{c.address ? ` · ${c.address}` : ''} · customer since{' '}
        {new Date(c.since).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">Orders</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{c.orders}</p>
        </div>
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">Kul kharcha</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{rupees(c.spendPaise)}</p>
        </div>
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">Avg basket</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{rupees(c.avgBasketPaise)}</p>
        </div>
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">Order cycle</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            {c.medianGapDays !== null ? `~${c.medianGapDays} din` : '—'}
          </p>
          {due && <p className="text-xs font-semibold text-[var(--warn,#9A4632)]">repeat due — {c.daysSinceLast} din ho gaye</p>}
        </div>
      </div>

      {data.opportunity && (
        <section className="pane card-in mt-6 border-l-4 border-l-[var(--accent)] p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">Opportunity</p>
          <p className="mt-1.5 text-sm leading-relaxed">{data.opportunity}</p>
        </section>
      )}

      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Aksar khareedte hain</h2>
        <div className="mt-4 flex flex-wrap gap-2.5">
          {data.frequent.map((f) => (
            <span key={f.name} className="rounded-lg border-2 border-[var(--ink)] px-3 py-1.5 text-sm">
              {f.name} · <b className="tabular-nums">{f.times}×</b>
            </span>
          ))}
          {data.frequent.length === 0 && <p className="muted text-sm">Abhi koi order nahi.</p>}
        </div>
      </section>

      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
          Recent baat-cheet
        </h2>
        <p className="muted mt-1 text-sm">
          Har turn asli events se — kaunsa desk bola, kya suna, kya kaha.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          {data.timeline.map((e) => (
            <div key={e.id} className="border-b border-[#1a1a1a12] pb-3">
              <p className="muted text-xs tabular-nums">
                {when(e.createdAt)} ·{' '}
                <span className="rounded border border-[var(--ink)] px-1.5 py-0.5">
                  {e.handoffTo && e.handoffFrom ? `${e.handoffFrom} → ${e.desk}` : e.desk}
                </span>
                {' '}· {e.act ?? '—'} · {e.latencyMs}ms · {e.channel}
              </p>
              <p className="mt-1.5 text-sm">&ldquo;{e.heard}&rdquo;</p>
              {e.reply && <p className="muted mt-0.5 text-sm">↳ {e.reply}</p>}
            </div>
          ))}
          {data.timeline.length === 0 && (
            <p className="muted text-sm">Event spine abhi naya hai — agli baat-cheet yahan dikhegi.</p>
          )}
        </div>
      </section>

      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Recent orders</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-[var(--ink)] text-left text-xs uppercase tracking-wide opacity-60">
                <th className="py-2 pr-4 font-semibold">Kab</th>
                <th className="py-2 pr-4 font-semibold">Amount</th>
                <th className="py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.recentOrders.map((o) => (
                <tr key={o.id} className="border-b border-[#1a1a1a12]">
                  <td className="py-2.5 pr-4">{when(o.createdAt)}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{rupees(o.totalPaise)}</td>
                  <td className="py-2.5">{o.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="muted mt-8 text-sm">Loading…</p>}>
      <CustomerDetail />
    </Suspense>
  );
}
