'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { get, rupees } from '@/lib/api';

/**
 * ONE PRODUCT, IN FULL: what it earned, who actually buys it, the
 * day-by-day movement, and where the stock stands. The overview's bar is
 * a headline; this is the ledger behind it -- the page a shopkeeper
 * opens before deciding how much to reorder.
 */

interface Detail {
  sku: { id: string; name: string; sellPaise: number; category: string | null };
  stock: number;
  last30: { units: number; paise: number; orders: number };
  buyers: Array<{ name: string; phone: string; units: number; paise: number; last: string }>;
  trend: Array<{ date: string; units: number; paise: number }>;
  recent: Array<{ at: string; customer: string; quantity: number; paise: number; status: string }>;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

function ProductDetail() {
  const skuId = useSearchParams().get('skuId') ?? '';
  const [data, setData] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!skuId) return;
    get<Detail>(`/analytics/product/detail?skuId=${encodeURIComponent(skuId)}`)
      .then(setData)
      .catch(() => setErr('Product detail load nahi hui.'));
  }, [skuId]);

  if (!skuId) return <p className="muted mt-8 text-sm">Koi product select nahi hua.</p>;
  if (err) return <p className="muted mt-8 text-sm">{err}</p>;
  if (!data) return <p className="muted mt-8 text-sm">Loading…</p>;

  const maxUnits = Math.max(1, ...data.trend.map((t) => t.units));
  const lowStock = data.stock <= 5;

  return (
    <>
      <Link href="/dashboard/insights" className="muted text-sm">← Insights</Link>
      <h1 className="display mt-2 text-[clamp(1.8rem,4vw,2.5rem)]">{data.sku.name}</h1>
      <p className="muted mt-2 text-sm">
        {data.sku.category ?? 'uncategorised'} · {rupees(data.sku.sellPaise)}
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">Bika · 30 din</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{data.last30.units} u</p>
        </div>
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">Kamai · 30 din</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{rupees(data.last30.paise)}</p>
        </div>
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">Orders</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{data.last30.orders}</p>
        </div>
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">Stock abhi</p>
          <p className={`mt-2 text-2xl font-semibold tabular-nums ${lowStock ? 'text-[var(--warn,#9A4632)]' : ''}`}>
            {data.stock}
          </p>
          {lowStock && <p className="muted text-xs">reorder ka time</p>}
        </div>
      </div>

      {/* movement */}
      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Din-b-din bikri</h2>
        {data.trend.length === 0 ? (
          <p className="muted mt-4 text-sm">30 din mein koi bikri nahi.</p>
        ) : (
          <div className="mt-4 flex items-end gap-1.5" style={{ height: 120 }}>
            {data.trend.map((t) => (
              <div key={t.date} className="flex flex-1 flex-col items-center gap-1" title={`${t.date}: ${t.units}u, ${rupees(t.paise)}`}>
                <span className="text-[10px] tabular-nums opacity-60">{t.units}</span>
                <div
                  className="w-full max-w-[38px] rounded-sm border border-[var(--ink)] bg-[var(--accent)]"
                  style={{ height: `${Math.max(6, (t.units / maxUnits) * 90)}px` }}
                />
                <span className="text-[10px] opacity-50">{t.date.slice(5)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* who buys it */}
      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Kaun khareedta hai</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-[var(--ink)] text-left text-xs uppercase tracking-wide opacity-60">
                <th className="py-2 pr-4 font-semibold">Customer</th>
                <th className="py-2 pr-4 font-semibold">Phone</th>
                <th className="py-2 pr-4 font-semibold">Units</th>
                <th className="py-2 pr-4 font-semibold">Kharcha</th>
                <th className="py-2 font-semibold">Aakhri order</th>
              </tr>
            </thead>
            <tbody>
              {data.buyers.map((b) => (
                <tr key={b.phone} className="border-b border-[#1a1a1a12]">
                  <td className="py-2.5 pr-4 font-semibold">{b.name}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{b.phone}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{b.units}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{rupees(b.paise)}</td>
                  <td className="py-2.5">{when(b.last)}</td>
                </tr>
              ))}
              {data.buyers.length === 0 && (
                <tr><td colSpan={5} className="muted py-4">Abhi koi buyer nahi.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* recent lines */}
      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Recent orders</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-[var(--ink)] text-left text-xs uppercase tracking-wide opacity-60">
                <th className="py-2 pr-4 font-semibold">Kab</th>
                <th className="py-2 pr-4 font-semibold">Kaun</th>
                <th className="py-2 pr-4 font-semibold">Qty</th>
                <th className="py-2 pr-4 font-semibold">Amount</th>
                <th className="py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((r, i) => (
                <tr key={i} className="border-b border-[#1a1a1a12]">
                  <td className="py-2.5 pr-4">{when(r.at)}</td>
                  <td className="py-2.5 pr-4">{r.customer}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{r.quantity}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{rupees(r.paise)}</td>
                  <td className="py-2.5">{r.status}</td>
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
      <ProductDetail />
    </Suspense>
  );
}
