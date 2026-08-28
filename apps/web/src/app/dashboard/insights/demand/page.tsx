'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { get } from '@/lib/api';

/**
 * ONE ASKED PHRASE, IN FULL. The overview said "namkeen, 11 baar" --
 * a metric. This page turns it into a decision: WHO asked, how often
 * each of them, the day-by-day trend, and every individual ask with what
 * the shop offered instead. "Ramesh has asked four times, most recently
 * today" is a reason to call the distributor; a count never is.
 */

interface Detail {
  asked: string;
  totalAsks: number;
  customers: Array<{ name: string; phone: string; times: number; last: string }>;
  log: Array<{ at: string; customer: string; confidence: number; offered: string | null }>;
  trend: Array<{ date: string; asks: number }>;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

function DemandDetail() {
  const q = useSearchParams().get('q') ?? '';
  const [data, setData] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!q) return;
    get<Detail>(`/analytics/demand/detail?q=${encodeURIComponent(q)}`)
      .then(setData)
      .catch(() => setErr('Detail load nahi hui.'));
  }, [q]);

  if (!q) return <p className="muted mt-8 text-sm">Koi phrase select nahi hui.</p>;
  if (err) return <p className="muted mt-8 text-sm">{err}</p>;
  if (!data) return <p className="muted mt-8 text-sm">Loading…</p>;

  const maxAsks = Math.max(1, ...data.trend.map((t) => t.asks));

  return (
    <>
      <Link href="/dashboard/insights" className="muted text-sm">← Insights</Link>
      <h1 className="display mt-2 text-[clamp(1.8rem,4vw,2.5rem)]">
        &ldquo;{data.asked}&rdquo;
      </h1>
      <p className="muted mt-2 max-w-xl text-sm leading-relaxed">
        Ye cheez maangi gayi aur shop mein nahi thi. Neeche pura record hai —
        kis-kis ne, kab-kab.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">Kul maang · 30 din</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{data.totalAsks}</p>
        </div>
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">Alag customers</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{data.customers.length}</p>
        </div>
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">Agla kadam</p>
          <p className="mt-2 text-sm leading-relaxed">
            Distributor se baat karke{' '}
            <Link href="/dashboard/catalogue" className="underline">catalogue mein add karein</Link>
            {' '}— maang already hai.
          </p>
        </div>
      </div>

      {/* day-by-day trend */}
      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Din-b-din maang</h2>
        <div className="mt-4 flex items-end gap-1.5" style={{ height: 120 }}>
          {data.trend.map((t) => (
            <div key={t.date} className="flex flex-1 flex-col items-center gap-1" title={`${t.date}: ${t.asks}`}>
              <span className="text-[10px] tabular-nums opacity-60">{t.asks}</span>
              <div
                className="w-full max-w-[38px] rounded-sm border border-[var(--ink)] bg-[var(--accent)]"
                style={{ height: `${Math.max(6, (t.asks / maxAsks) * 90)}px` }}
              />
              <span className="text-[10px] opacity-50">{t.date.slice(5)}</span>
            </div>
          ))}
        </div>
      </section>

      {/* who asked */}
      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Kis-kis ne maanga</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-[var(--ink)] text-left text-xs uppercase tracking-wide opacity-60">
                <th className="py-2 pr-4 font-semibold">Customer</th>
                <th className="py-2 pr-4 font-semibold">Phone</th>
                <th className="py-2 pr-4 font-semibold">Kitni baar</th>
                <th className="py-2 font-semibold">Aakhri baar</th>
              </tr>
            </thead>
            <tbody>
              {data.customers.map((c) => (
                <tr key={c.phone} className="border-b border-[#1a1a1a12]">
                  <td className="py-2.5 pr-4 font-semibold">{c.name}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{c.phone}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{c.times}</td>
                  <td className="py-2.5">{when(c.last)}</td>
                </tr>
              ))}
              {data.customers.length === 0 && (
                <tr><td colSpan={4} className="muted py-4">Customer records nahi mile.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* the raw log */}
      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Har ek maang</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-[var(--ink)] text-left text-xs uppercase tracking-wide opacity-60">
                <th className="py-2 pr-4 font-semibold">Kab</th>
                <th className="py-2 pr-4 font-semibold">Kaun</th>
                <th className="py-2 pr-4 font-semibold">Match score</th>
                <th className="py-2 font-semibold">Badle mein diya</th>
              </tr>
            </thead>
            <tbody>
              {data.log.map((l, i) => (
                <tr key={i} className="border-b border-[#1a1a1a12]">
                  <td className="py-2.5 pr-4">{when(l.at)}</td>
                  <td className="py-2.5 pr-4">{l.customer}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{Math.round(l.confidence * 100)}%</td>
                  <td className="py-2.5 muted">{l.offered ?? '—'}</td>
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
      <DemandDetail />
    </Suspense>
  );
}
