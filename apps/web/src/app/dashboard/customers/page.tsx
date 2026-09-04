'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Brain, Clock3, PhoneCall, Search, ShieldCheck, ShoppingBag } from 'lucide-react';
import { get, rupees } from '@/lib/api';
import { IntelSkeleton } from '@/components/Loading';

interface Row {
  id: string;
  name: string;
  phone: string;
  address: string | null;
  since: string;
  autonomyTier: string;
  orders: number;
  spendPaise: number;
  avgBasketPaise: number;
  lastOrder: string | null;
  medianGapDays: number | null;
  daysSinceLast: number | null;
  trackedItems: number;
  dueItems: number;
  nextItem: string | null;
  nextItemDays: number | null;
  lastNudge: { sentAt: string; outcome: string | null; templateName: string } | null;
}

const ago = (iso: string | null) => {
  if (!iso) return 'no orders';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};

const dueLabel = (days: number | null) => {
  if (days === null) return 'learning';
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'today';
  return `${days}d left`;
};

function tierLabel(tier: string) {
  return tier.toLowerCase().replace(/_/g, ' ');
}

export default function Customers() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [query, setQuery] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    get<{ customers: Row[] }>('/intel/customers')
      .then((r) => setRows(r.customers))
      .catch(() => setErr('Customers load nahi hue.'));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!rows || !q) return rows;
    return rows.filter((r) =>
      [r.name, r.phone, r.address, r.nextItem].filter(Boolean).some((v) => v!.toLowerCase().includes(q)),
    );
  }, [query, rows]);

  if (err) return <p className="muted mt-8 text-sm">{err}</p>;
  if (!rows || !filtered) return <IntelSkeleton />;

  const totals = rows.reduce(
    (acc, row) => ({
      tracked: acc.tracked + row.trackedItems,
      due: acc.due + row.dueItems,
      spend: acc.spend + row.spendPaise,
      orders: acc.orders + row.orders,
    }),
    { tracked: 0, due: 0, spend: 0, orders: 0 },
  );

  return (
    <>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white px-3 py-1 text-xs font-semibold text-[var(--muted)]">
            <Brain className="h-3.5 w-3.5 text-[var(--accent)]" />
            Customer intelligence
          </div>
          <h1 className="display mt-3 text-[clamp(2rem,4vw,2.85rem)]">Customers</h1>
          <p className="muted mt-2 max-w-2xl text-sm leading-relaxed">
            Real customers ranked by reorder urgency and value. Every signal below comes from orders,
            burn-rate rows, nudges, and the agent event spine.
          </p>
        </div>

        <label className="relative block w-full lg:w-[320px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search customer, phone, item"
            className="inv-field pl-9"
          />
        </label>
      </div>

      <section className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric icon={ShoppingBag} label="Orders seen" value={totals.orders.toLocaleString('en-IN')} />
        <Metric icon={Brain} label="Tracked items" value={totals.tracked.toLocaleString('en-IN')} />
        <Metric icon={PhoneCall} label="Call signals" value={totals.due.toLocaleString('en-IN')} />
        <Metric icon={ShieldCheck} label="Customer value" value={rupees(totals.spend)} />
      </section>

      <section className="pane mt-7 overflow-hidden">
        <div className="grid grid-cols-[1.2fr_0.9fr_0.85fr_0.75fr_auto] gap-4 border-b border-[var(--line)] px-5 py-3 text-xs font-semibold uppercase text-[var(--muted)] max-lg:hidden">
          <span>Customer</span>
          <span>AI tracking</span>
          <span>Next action</span>
          <span>Value</span>
          <span />
        </div>

        <div className="divide-y divide-[var(--line)]">
          {filtered.map((row) => (
            <Link
              key={row.id}
              href={`/dashboard/customers/detail?householdId=${row.id}`}
              className="group grid gap-4 px-5 py-4 transition hover:bg-[#f7f7ff] lg:grid-cols-[1.2fr_0.9fr_0.85fr_0.75fr_auto] lg:items-center"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold">{row.name}</span>
                  {row.dueItems > 0 && (
                    <span className="rounded-full bg-[#fef2f2] px-2 py-0.5 text-[11px] font-semibold text-[#b91c1c]">
                      due
                    </span>
                  )}
                </div>
                <p className="muted mt-1 truncate text-xs tabular-nums">{row.phone}</p>
                <p className="muted mt-0.5 truncate text-xs">{row.address ?? tierLabel(row.autonomyTier)}</p>
              </div>

              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Brain className="h-4 w-4 text-[var(--accent)]" />
                  {row.trackedItems} items
                </div>
                <p className="muted mt-1 text-xs">
                  {row.medianGapDays ? `usual gap ${row.medianGapDays}d` : 'learning order rhythm'}
                </p>
              </div>

              <div>
                <p className="text-sm font-semibold">{row.nextItem ?? 'No item due'}</p>
                <p className="muted mt-1 flex items-center gap-1 text-xs">
                  <Clock3 className="h-3.5 w-3.5" />
                  {row.dueItems ? `${row.dueItems} signal${row.dueItems === 1 ? '' : 's'} · ` : ''}
                  {dueLabel(row.nextItemDays)}
                </p>
              </div>

              <div>
                <p className="text-sm font-semibold tabular-nums">{rupees(row.spendPaise)}</p>
                <p className="muted mt-1 text-xs">
                  {row.orders} orders · avg {rupees(row.avgBasketPaise)}
                </p>
                <p className="muted mt-0.5 text-xs">last {ago(row.lastOrder)}</p>
              </div>

              <div className="flex justify-end">
                <span className="grid h-9 w-9 place-items-center rounded-full border border-[var(--line)] bg-white transition group-hover:border-[var(--accent)] group-hover:text-[var(--accent)]">
                  <ArrowUpRight className="h-4 w-4" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="pane p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase text-[var(--muted)]">{label}</p>
        <Icon className="h-4 w-4 text-[var(--accent)]" />
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
