'use client';

import { useEffect, useState } from 'react';
import { get, rupees } from '@/lib/api';

/**
 * THE SHOPKEEPER'S INSIGHT PANEL, and the reason the middle section
 * exists at all is the ledger behind it.
 *
 * Top products and low stock are useful but ordinary -- any POS shows
 * them. "Maanga gaya, mila nahi" is the number a kirana has never had:
 * every request the resolver could not match was written down mid-call
 * (see noteUnmet in conversation/core.ts), and this page is where those
 * apologies turn into a purchase list. Eleven people asked for namkeen
 * this week and you sold none of it -- that sentence is the business.
 */

interface Insights {
  sinceDays: number;
  demand: Array<{
    asked: string;
    times: number;
    households: number;
    lastAsked: string;
    offered: string | null;
  }>;
  topProducts: Array<{ name: string; units: number; paise: number }>;
  lowStock: Array<{ name: string; quantity: number }>;
}

const ago = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days === 0 ? 'aaj' : days === 1 ? 'kal' : `${days} din pehle`;
};

export default function Insights() {
  const [data, setData] = useState<Insights | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    get<Insights>('/analytics/insights')
      .then(setData)
      .catch(() => setErr('Insights load nahi hue. Thodi der mein try karein.'));
  }, []);

  if (err) return <p className="muted mt-8 text-sm">{err}</p>;
  if (!data) return <p className="muted mt-8 text-sm">Loading…</p>;

  const missedAsks = data.demand.reduce((s, d) => s + d.times, 0);
  const maxUnits = Math.max(1, ...data.topProducts.map((p) => p.units));

  return (
    <>
      <h1 className="display text-[clamp(2rem,4vw,2.75rem)]">Insights</h1>
      <p className="muted mt-2 max-w-xl text-sm leading-relaxed">
        Kya bik raha hai, kya khatam ho raha hai — aur kya maanga gaya jo
        aapke paas tha hi nahi.
      </p>

      {/* ---- the three numbers ---- */}
      <div className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">
            Sabse zyada bika · 30 din
          </p>
          <p className="mt-2 text-lg font-semibold">
            {data.topProducts[0]?.name ?? '—'}
          </p>
          <p className="muted text-sm tabular-nums">
            {data.topProducts[0] ? `${data.topProducts[0].units} units` : ''}
          </p>
        </div>
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">
            Missed maang · {data.sinceDays} din
          </p>
          <p className="mt-2 text-lg font-semibold tabular-nums">{missedAsks} baar</p>
          <p className="muted text-sm tabular-nums">
            {data.demand.length} alag cheezein
          </p>
        </div>
        <div className="pane card-in p-5">
          <p className="text-xs font-semibold tracking-wide uppercase opacity-60">
            Stock kam
          </p>
          <p className="mt-2 text-lg font-semibold tabular-nums">
            {data.lowStock.length} items
          </p>
          <p className="muted text-sm">5 ya usse kam bache</p>
        </div>
      </div>

      {/* ---- what could not be sold: the ledger, readable ---- */}
      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
          Maanga gaya, mila nahi
        </h2>
        <p className="muted mt-1 text-sm">
          Customers ne jo cheezein maangi aur shop mein nahi thin — har call
          se apne aap likhi jaati hain.
        </p>

        {data.demand.length === 0 ? (
          <p className="muted mt-5 text-sm">
            Pichhle {data.sinceDays} din mein sab kuch mil gaya. Accha hai.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-[var(--ink)] text-left text-xs uppercase tracking-wide opacity-60">
                  <th className="py-2 pr-4 font-semibold">Kya maanga</th>
                  <th className="py-2 pr-4 font-semibold">Kitni baar</th>
                  <th className="py-2 pr-4 font-semibold">Kitne ghar</th>
                  <th className="py-2 pr-4 font-semibold">Aakhri baar</th>
                  <th className="py-2 font-semibold">Badle mein diya</th>
                </tr>
              </thead>
              <tbody>
                {data.demand.map((d) => (
                  <tr key={d.asked} className="border-b border-[#1a1a1a12]">
                    <td className="py-2.5 pr-4 font-semibold">&ldquo;{d.asked}&rdquo;</td>
                    <td className="py-2.5 pr-4 tabular-nums">{d.times}</td>
                    <td className="py-2.5 pr-4 tabular-nums">{d.households}</td>
                    <td className="py-2.5 pr-4">{ago(d.lastAsked)}</td>
                    <td className="py-2.5 muted">{d.offered ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---- what sells ---- */}
      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
          Sabse zyada bikta hai · 30 din
        </h2>
        <div className="mt-4 flex flex-col gap-2.5">
          {data.topProducts.length === 0 && (
            <p className="muted text-sm">Abhi koi order data nahi hai.</p>
          )}
          {data.topProducts.map((p) => (
            <div key={p.name} className="flex items-center gap-3">
              <span className="w-[38%] min-w-[150px] truncate text-sm">{p.name}</span>
              <div className="h-4 flex-1 rounded-sm bg-[#1a1a1a12]">
                <div
                  className="h-full rounded-sm bg-[var(--accent)] border border-[var(--ink)]"
                  style={{ width: `${Math.max(4, (p.units / maxUnits) * 100)}%` }}
                />
              </div>
              <span className="w-20 text-right text-sm tabular-nums">{p.units} u</span>
              <span className="muted w-24 text-right text-sm tabular-nums">
                {rupees(p.paise)}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ---- what is running out ---- */}
      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
          Stock khatam hone wala hai
        </h2>
        {data.lowStock.length === 0 ? (
          <p className="muted mt-4 text-sm">Sab theek hai — kuch bhi 5 se neeche nahi.</p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2.5">
            {data.lowStock.map((r) => (
              <span
                key={r.name}
                className="rounded-lg border-2 border-[var(--ink)] px-3 py-1.5 text-sm"
              >
                {r.name} · <b className="tabular-nums">{r.quantity}</b> bache
              </span>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
