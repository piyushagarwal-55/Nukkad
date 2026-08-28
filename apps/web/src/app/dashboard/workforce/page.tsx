'use client';

import { useEffect, useState } from 'react';
import { get } from '@/lib/api';
import { IntelSkeleton } from '@/components/Loading';

/**
 * THE AI WORKFORCE, MEASURED. Every number is an aggregation over the
 * AgentEvent spine handle() writes per turn -- so "each agent has a
 * measurable responsibility and output" is a query result, not a slide.
 * Below the table, the recent decisions feed shows the actual work.
 */

interface Desk {
  desk: string;
  turns: number;
  avgLatencyMs: number;
  handoffsOut: number;
  handoffsIn: number;
  topActs: Array<{ act: string; n: number }>;
}
interface Workforce { sinceDays: number; demandSignals: number; desks: Desk[] }
interface Ev {
  id: string; createdAt: string; desk: string; act: string | null;
  heard: string; reply: string | null; handoffFrom: string | null;
  handoffTo: string | null; customer: string; latencyMs: number;
}

const ROLES: Record<string, string> = {
  RECEPTION: 'Phone uthata hai, samajhta hai kaam kya hai, sahi counter par lagata hai.',
  SELLER: 'Products, daam, stock, basket — aur jo nahi mila usse demand ledger mein likhta hai.',
  CHECKOUT: 'Bill, address, offers, payment link. Payment sirf Razorpay se verify hota hai.',
  ENQUIRY: 'Order status aur purana record, seedha database se.',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

export default function Workforce() {
  const [data, setData] = useState<Workforce | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      get<Workforce>('/intel/workforce'),
      get<{ events: Ev[] }>('/intel/conversations'),
    ])
      .then(([w, c]) => {
        setData(w);
        setEvents(c.events.slice(0, 25));
      })
      .catch(() => setErr('Workforce data load nahi hua.'));
  }, []);

  if (err) return <p className="muted mt-8 text-sm">{err}</p>;
  if (!data) return <IntelSkeleton />;

  return (
    <>
      <h1 className="display text-[clamp(2rem,4vw,2.75rem)]">AI Workforce</h1>
      <p className="muted mt-2 max-w-xl text-sm leading-relaxed">
        Har agent ki asli ginti — kitne turns, kitni tezi, kitne handoffs.
        Pichhle {data.sinceDays} din. Inventory intelligence ne{' '}
        <b className="tabular-nums">{data.demandSignals}</b> demand signals pakde.
      </p>

      <section className="pane card-in mt-7 p-6">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-[var(--ink)] text-left text-xs uppercase tracking-wide opacity-60">
                <th className="py-2 pr-4 font-semibold">Agent</th>
                <th className="py-2 pr-4 font-semibold">Turns</th>
                <th className="py-2 pr-4 font-semibold">Avg jawab</th>
                <th className="py-2 pr-4 font-semibold">Handoffs diye</th>
                <th className="py-2 pr-4 font-semibold">Handoffs mile</th>
                <th className="py-2 font-semibold">Sabse zyada kaam</th>
              </tr>
            </thead>
            <tbody>
              {data.desks.map((d) => (
                <tr key={d.desk} className="border-b border-[#1a1a1a12] align-top">
                  <td className="py-3 pr-4">
                    <p className="font-semibold">{d.desk}</p>
                    <p className="muted mt-0.5 max-w-[260px] text-xs leading-relaxed">
                      {ROLES[d.desk] ?? ''}
                    </p>
                  </td>
                  <td className="py-3 pr-4 tabular-nums">{d.turns}</td>
                  <td className="py-3 pr-4 tabular-nums">
                    {(d.avgLatencyMs / 1000).toFixed(1)}s
                  </td>
                  <td className="py-3 pr-4 tabular-nums">{d.handoffsOut}</td>
                  <td className="py-3 pr-4 tabular-nums">{d.handoffsIn}</td>
                  <td className="py-3">
                    {d.topActs.map((a) => (
                      <span key={a.act} className="mr-1.5 inline-block rounded border border-[var(--ink)] px-1.5 py-0.5 text-xs">
                        {a.act} ×{a.n}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
              {data.desks.length === 0 && (
                <tr><td colSpan={6} className="muted py-5">
                  Event spine abhi naya hai — pehli baat-cheet ke baad numbers aayenge.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="pane card-in mt-6 p-6">
        <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">Recent decisions</h2>
        <p className="muted mt-1 text-sm">Asli kaam, jaise hua — har turn ek event hai.</p>
        <div className="mt-4 flex flex-col gap-3">
          {events.map((e) => (
            <div key={e.id} className="border-b border-[#1a1a1a12] pb-3">
              <p className="muted text-xs tabular-nums">
                {when(e.createdAt)} ·{' '}
                <span className="rounded border border-[var(--ink)] px-1.5 py-0.5">
                  {e.handoffTo && e.handoffFrom ? `${e.handoffFrom} → ${e.desk}` : e.desk}
                </span>
                {' '}· {e.customer} · {e.act ?? '—'} · {(e.latencyMs / 1000).toFixed(1)}s
              </p>
              <p className="mt-1.5 text-sm">&ldquo;{e.heard}&rdquo;</p>
              {e.reply && <p className="muted mt-0.5 text-sm">↳ {e.reply}</p>}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
