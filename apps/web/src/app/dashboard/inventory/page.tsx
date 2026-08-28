'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { get, post } from '@/lib/api';
import { IntelSkeleton } from '@/components/Loading';

/**
 * INVENTORY INTELLIGENCE, WITH THE LOOP CLOSED. Attention cards from
 * stock velocity and the unmet ledger; recommendations that become rows
 * a shopkeeper acts on. Customer asks -> agent cannot fulfil -> demand
 * captured -> recommendation -> Mark as ordered -> tracked. That last
 * step is what separates an operating system from a graph.
 */

interface Card { level: 'red' | 'orange' | 'green'; title: string; body: string; href: string }
interface Insights {
  sinceDays: number;
  demand: Array<{ asked: string; times: number; households: number; lastAsked: string; offered: string | null }>;
  lowStock: Array<{ name: string; quantity: number }>;
}
interface Action { id: string; query: string; status: string; createdAt: string }

const TINT: Record<Card['level'], string> = {
  red: 'border-l-[#9A4632]',
  orange: 'border-l-[#B98115]',
  green: 'border-l-[#3F7263]',
};

export default function Inventory() {
  const [cards, setCards] = useState<Card[]>([]);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      get<{ cards: Card[] }>('/intel/attention'),
      get<Insights>('/analytics/insights'),
      get<{ actions: Action[] }>('/intel/restock'),
    ])
      .then(([a, i, r]) => {
        setCards(a.cards);
        setInsights(i);
        setActions(r.actions);
      })
      .catch(() => setErr('Inventory intelligence load nahi hui.'));
  }, []);

  useEffect(load, [load]);

  const recommend = useCallback(async (query: string) => {
    await post('/intel/restock', { query });
    load();
  }, [load]);

  const setStatus = useCallback(async (id: string, status: string) => {
    await post('/intel/restock/status', { id, status });
    load();
  }, [load]);

  if (err) return <p className="muted mt-8 text-sm">{err}</p>;
  if (!insights) return <IntelSkeleton />;

  const open = new Set(actions.filter((a) => a.status === 'OPEN').map((a) => a.query.toLowerCase()));

  return (
    <>
      <h1 className="display text-[clamp(2rem,4vw,2.75rem)]">Inventory Intelligence</h1>
      <p className="muted mt-2 max-w-xl text-sm leading-relaxed">
        Kya khatam ho raha hai, kya maanga ja raha hai — aur uspe kya karna
        hai. Har recommendation asli maang se nikli hai.
      </p>

      {/* attention */}
      {cards.length > 0 && (
        <div className="mt-7 flex flex-col gap-3">
          {cards.map((c) => (
            <Link
              key={c.title}
              href={c.href}
              className={`pane card-in block border-l-4 p-5 ${TINT[c.level]}`}
            >
              <p className="font-semibold">{c.title}</p>
              <p className="muted mt-1 text-sm">{c.body}</p>
            </Link>
          ))}
        </div>
      )}

      {/* demand signals with actions */}
      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Demand signals · {insights.sinceDays} din</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead>
              <tr className="border-b border-[var(--ink)] text-left text-xs uppercase tracking-wide opacity-60">
                <th className="py-2 pr-4 font-semibold">Maanga gaya</th>
                <th className="py-2 pr-4 font-semibold">Kitni baar</th>
                <th className="py-2 pr-4 font-semibold">Ghar</th>
                <th className="py-2 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {insights.demand.map((d) => (
                <tr key={d.asked} className="border-b border-[#1a1a1a12]">
                  <td className="py-2.5 pr-4 font-semibold">
                    <Link
                      href={`/dashboard/insights/demand?q=${encodeURIComponent(d.asked)}`}
                      className="underline decoration-[var(--accent)] decoration-2 underline-offset-2"
                    >
                      &ldquo;{d.asked}&rdquo;
                    </Link>
                  </td>
                  <td className="py-2.5 pr-4 tabular-nums">{d.times}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{d.households}</td>
                  <td className="py-2.5">
                    {open.has(d.asked.toLowerCase()) ? (
                      <span className="muted text-xs">recommendation bani hui hai</span>
                    ) : (
                      <button
                        onClick={() => recommend(d.asked)}
                        className="rounded-lg border-2 border-[var(--ink)] bg-[var(--accent)] px-2.5 py-1 text-xs font-semibold"
                      >
                        Create restock recommendation
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {insights.demand.length === 0 && (
                <tr><td colSpan={4} className="muted py-4">Is hafte sab kuch mil gaya.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* the loop */}
      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Restock actions</h2>
        <p className="muted mt-1 text-sm">Recommendation → decision → track. Loop yahan band hota hai.</p>
        <div className="mt-4 flex flex-col gap-2.5">
          {actions.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2.5 border-b border-[#1a1a1a12] pb-2.5">
              <span className="font-semibold">&ldquo;{a.query}&rdquo;</span>
              <span className="rounded border border-[var(--ink)] px-1.5 py-0.5 text-xs">{a.status}</span>
              {a.status === 'OPEN' && (
                <span className="flex gap-1.5">
                  <button onClick={() => setStatus(a.id, 'ORDERED')} className="rounded-lg border-2 border-[var(--ink)] px-2 py-0.5 text-xs font-semibold">Mark as ordered</button>
                  <button onClick={() => setStatus(a.id, 'IGNORED')} className="rounded-lg border-2 border-[var(--ink)] px-2 py-0.5 text-xs">Ignore</button>
                  <button onClick={() => setStatus(a.id, 'STOCKED')} className="rounded-lg border-2 border-[var(--ink)] px-2 py-0.5 text-xs">Already stocked</button>
                </span>
              )}
            </div>
          ))}
          {actions.length === 0 && <p className="muted text-sm">Abhi koi action nahi bani.</p>}
        </div>
      </section>

      {/* stock */}
      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Stock kam</h2>
        {insights.lowStock.length === 0 ? (
          <p className="muted mt-4 text-sm">Kuch bhi 5 se neeche nahi.</p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2.5">
            {insights.lowStock.map((r) => (
              <span key={r.name} className="rounded-lg border-2 border-[var(--ink)] px-3 py-1.5 text-sm">
                {r.name} · <b className="tabular-nums">{r.quantity}</b> bache
              </span>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
