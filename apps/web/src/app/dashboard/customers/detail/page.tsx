'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  BadgeIndianRupee,
  Brain,
  CalendarClock,
  CheckCircle2,
  Clock3,
  MessageSquareText,
  PhoneCall,
  Radar,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { get, post, rupees } from '@/lib/api';
import { IntelSkeleton } from '@/components/Loading';

interface Detail {
  customer: {
    id: string;
    name: string;
    phone: string;
    address: string | null;
    since: string;
    memberCount: number;
    autonomyTier: string;
    streak: number;
    vetoWindowMins: number;
    capPaise: number | null;
    orders: number;
    spendPaise: number;
    avgBasketPaise: number;
    medianGapDays: number | null;
    daysSinceLast: number | null;
  };
  summary: string;
  tracked: Array<{
    skuId: string;
    name: string;
    category: string | null;
    unit: string;
    qtyPerDay: number;
    lastQty: number | null;
    lastPurchaseAt: string | null;
    daysSincePurchase: number | null;
    predictedDepletionAt: string | null;
    daysUntilDepletion: number | null;
    observations: number;
    seeded: boolean;
    updatedAt: string;
    stockInShop: number | null;
    consumedPct: number | null;
    signal: string;
  }>;
  careCall: {
    lines: Array<{
      skuId: string;
      name: string;
      quantityHint: number | null;
      daysSincePurchase: number | null;
      predictedDepletionAt: string | null;
      reason: string;
    }>;
    offer: { title: string; minBasketPaise: number; flatOffPaise: number } | null;
    openingScript: string;
    guardrail: string;
  } | null;
  frequent: Array<{ name: string; times: number; units: number }>;
  recentOrders: Array<{
    id: string;
    createdAt: string;
    totalPaise: number;
    status: string;
    source: string;
    lines: Array<{
      quantity: number;
      sourceText: string;
      linePaise: number;
      method: string;
      confidence: number;
      wasSubstituted: boolean;
      sku: { id: string; name: string; category: string | null; unit: string } | null;
    }>;
  }>;
  timeline: Array<{
    id: string;
    createdAt: string;
    desk: string;
    act: string | null;
    heard: string;
    reply: string | null;
    handoffFrom: string | null;
    handoffTo: string | null;
    channel: string;
    latencyMs: number;
  }>;
  unmetDemand: Array<{
    id: string;
    query: string;
    offered: string | null;
    confidence: number;
    createdAt: string;
  }>;
  nudges: Array<{
    id: string;
    templateName: string;
    sentAt: string;
    respondedAt: string | null;
    outcome: string | null;
  }>;
  opportunity: string | null;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

const dateOnly = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'not observed';

function signalTone(signal: string) {
  if (signal === 'likely empty') return 'bg-[#fef2f2] text-[#b91c1c]';
  if (signal === 'call window') return 'bg-[#fffbeb] text-[#92400e]';
  if (signal === 'monitoring') return 'bg-[#ecfdf5] text-[#047857]';
  return 'bg-[#f4f4f5] text-[var(--muted)]';
}

function daysLabel(days: number | null) {
  if (days === null) return 'learning';
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days === 0) return 'due today';
  return `${days} days left`;
}

function CustomerDetail() {
  const id = useSearchParams().get('householdId') ?? '';
  const [data, setData] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    get<Detail>(`/intel/customer/detail?householdId=${encodeURIComponent(id)}`)
      .then(setData)
      .catch(() => setErr('Customer detail load nahi hui.'));
  }, [id]);

  const topTracked = useMemo(() => data?.tracked.slice(0, 6) ?? [], [data]);

  async function startCall() {
    if (!data) return;
    setCalling(true);
    setCallResult(null);
    try {
      const res = await post<{ callSid: string; to: string }>('/care-calls/call', {
        householdId: data.customer.id,
        days: 14,
      });
      setCallResult(`Call started to ${res.to}`);
    } catch (e) {
      setCallResult((e as Error).message);
    } finally {
      setCalling(false);
    }
  }

  if (!id) return <p className="muted mt-8 text-sm">Koi customer select nahi hua.</p>;
  if (err) return <p className="muted mt-8 text-sm">{err}</p>;
  if (!data) return <IntelSkeleton />;

  const c = data.customer;

  return (
    <>
      <Link href="/dashboard/customers" className="muted inline-flex items-center gap-2 text-sm">
        <ArrowLeft className="h-4 w-4" />
        Customers
      </Link>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_320px]">
        <section className="pane overflow-hidden">
          <div className="border-b border-[var(--line)] bg-[#f7f7ff] px-6 py-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="display text-[clamp(2rem,4vw,2.8rem)]">{c.name}</h1>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-[var(--accent)]">
                    {c.autonomyTier.toLowerCase()}
                  </span>
                </div>
                <p className="muted mt-2 text-sm tabular-nums">
                  {c.phone}{c.address ? ` · ${c.address}` : ''}
                </p>
              </div>
              <button
                onClick={startCall}
                disabled={calling || !data.careCall}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-45"
                title={data.careCall ? 'Start AI care call' : 'No care-call signal right now'}
              >
                <PhoneCall className="h-4 w-4" />
                {calling ? 'Calling...' : 'Start care call'}
              </button>
            </div>
            {callResult && <p className="mt-3 text-sm text-[var(--muted)]">{callResult}</p>}
          </div>

          <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
            <Metric icon={ReceiptText} label="Orders" value={c.orders.toLocaleString('en-IN')} />
            <Metric icon={BadgeIndianRupee} label="Total spend" value={rupees(c.spendPaise)} />
            <Metric icon={TrendingUp} label="Avg basket" value={rupees(c.avgBasketPaise)} />
            <Metric
              icon={CalendarClock}
              label="Order rhythm"
              value={c.medianGapDays ? `${c.medianGapDays}d` : 'learning'}
              note={c.daysSinceLast !== null ? `last ${c.daysSinceLast}d ago` : undefined}
            />
          </div>
        </section>

        <section className="pane p-5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold uppercase text-[var(--muted)]">Autonomy</h2>
          </div>
          <div className="mt-4 space-y-3 text-sm">
            <Fact label="Household size" value={`${c.memberCount} people`} />
            <Fact label="Correct streak" value={`${c.streak}`} />
            <Fact label="Veto window" value={`${c.vetoWindowMins} min`} />
            <Fact label="Silent cap" value={c.capPaise ? rupees(c.capPaise) : 'not set'} />
          </div>
        </section>
      </div>

      <section className="pane mt-6 p-6">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[var(--accent)]" />
          <h2 className="text-sm font-semibold uppercase text-[var(--muted)]">AI summary</h2>
        </div>
        <p className="mt-3 text-[15px] leading-7">{data.summary}</p>
        {data.opportunity && (
          <p className="mt-3 rounded-xl border border-[#c7d2fe] bg-[#eef2ff] px-4 py-3 text-sm leading-6">
            {data.opportunity}
          </p>
        )}
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="pane p-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-[var(--accent)]" />
              <h2 className="text-sm font-semibold uppercase text-[var(--muted)]">
                Item depletion tracking
              </h2>
            </div>
            <span className="text-xs font-semibold text-[var(--muted)]">{data.tracked.length} rows</span>
          </div>

          <div className="mt-5 space-y-3">
            {topTracked.map((item) => (
              <div key={item.skuId} className="rounded-2xl border border-[var(--line)] bg-white p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{item.name}</p>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${signalTone(item.signal)}`}>
                        {item.signal}
                      </span>
                    </div>
                    <p className="muted mt-1 text-xs">
                      last bought {dateOnly(item.lastPurchaseAt)} · {item.observations} observation
                      {item.observations === 1 ? '' : 's'}{item.seeded ? ' · seeded baseline' : ''}
                    </p>
                  </div>
                  <p className="text-sm font-semibold tabular-nums">{daysLabel(item.daysUntilDepletion)}</p>
                </div>

                <div className="mt-4 h-2 overflow-hidden rounded-full bg-[#e4e4e7]">
                  <div
                    className="h-full rounded-full bg-[var(--accent)]"
                    style={{ width: `${item.consumedPct ?? 18}%` }}
                  />
                </div>

                <div className="mt-3 grid gap-2 text-xs text-[var(--muted)] sm:grid-cols-4">
                  <span>Rate {item.qtyPerDay.toFixed(2)} {item.unit}/day</span>
                  <span>Last qty {item.lastQty ?? 'n/a'}</span>
                  <span>Shop stock {item.stockInShop ?? 'n/a'}</span>
                  <span>Updated {dateOnly(item.updatedAt)}</span>
                </div>
              </div>
            ))}
            {data.tracked.length === 0 && <p className="muted text-sm">No burn-rate rows yet.</p>}
          </div>
        </div>

        <aside className="pane p-6">
          <div className="flex items-center gap-2">
            <PhoneCall className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold uppercase text-[var(--muted)]">Care-call plan</h2>
          </div>

          {data.careCall ? (
            <>
              <div className="mt-4 space-y-2">
                {data.careCall.lines.map((line) => (
                  <div key={line.skuId} className="rounded-xl border border-[var(--line)] bg-white px-3 py-2">
                    <p className="text-sm font-semibold">{line.name}</p>
                    <p className="muted mt-0.5 text-xs">
                      {line.daysSincePurchase !== null ? `${line.daysSincePurchase}d since purchase` : 'no purchase date'}
                      {line.quantityHint !== null ? ` · qty hint ${line.quantityHint}` : ''}
                    </p>
                  </div>
                ))}
              </div>
              {data.careCall.offer && (
                <p className="mt-4 rounded-xl bg-[#ecfdf5] px-3 py-2 text-sm text-[#047857]">
                  {data.careCall.offer.title}
                </p>
              )}
              <div className="mt-4 rounded-2xl bg-[#18181b] p-4 text-sm leading-6 text-white">
                {data.careCall.openingScript}
              </div>
            </>
          ) : (
            <p className="muted mt-4 text-sm">No item is inside the current care-call window.</p>
          )}
        </aside>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Frequent basket" icon={ShoppingIcon}>
          <div className="flex flex-wrap gap-2">
            {data.frequent.map((f) => (
              <span key={f.name} className="rounded-full border border-[var(--line)] bg-white px-3 py-1.5 text-sm">
                {f.name} · <b>{f.times}x</b>
              </span>
            ))}
            {data.frequent.length === 0 && <p className="muted text-sm">No purchased items yet.</p>}
          </div>
        </Panel>

        <Panel title="Unmet demand" icon={MessageSquareText}>
          <div className="space-y-3">
            {data.unmetDemand.map((u) => (
              <div key={u.id} className="rounded-xl border border-[var(--line)] bg-white px-3 py-2">
                <p className="text-sm font-semibold">"{u.query}"</p>
                <p className="muted mt-1 text-xs">
                  {when(u.createdAt)}{u.offered ? ` · offered ${u.offered}` : ''}
                </p>
              </div>
            ))}
            {data.unmetDemand.length === 0 && <p className="muted text-sm">No unresolved item asks.</p>}
          </div>
        </Panel>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-[1fr_420px]">
        <Panel title="Recent orders" icon={ReceiptText}>
          <div className="space-y-4">
            {data.recentOrders.map((order) => (
              <div key={order.id} className="rounded-2xl border border-[var(--line)] bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{when(order.createdAt)}</p>
                    <p className="muted text-xs">{order.status} · {order.source}</p>
                  </div>
                  <p className="font-semibold tabular-nums">{rupees(order.totalPaise)}</p>
                </div>
                <div className="mt-3 space-y-2">
                  {order.lines.slice(0, 5).map((line, idx) => (
                    <div key={`${order.id}-${idx}`} className="flex items-start justify-between gap-3 text-sm">
                      <span className="min-w-0">
                        <b>{line.sku?.name ?? line.sourceText}</b>
                        <span className="muted"> · {line.quantity} {line.sku?.unit ?? ''}</span>
                      </span>
                      <span className="muted shrink-0 text-xs">{line.method}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {data.recentOrders.length === 0 && <p className="muted text-sm">No orders yet.</p>}
          </div>
        </Panel>

        <Panel title="Nudges" icon={Clock3}>
          <div className="space-y-3">
            {data.nudges.map((nudge) => (
              <div key={nudge.id} className="rounded-xl border border-[var(--line)] bg-white px-3 py-2">
                <p className="text-sm font-semibold">{nudge.templateName.replace(/_/g, ' ')}</p>
                <p className="muted mt-1 text-xs">
                  {when(nudge.sentAt)} · {nudge.outcome ?? 'waiting'}
                </p>
              </div>
            ))}
            {data.nudges.length === 0 && <p className="muted text-sm">No proactive nudge sent yet.</p>}
          </div>
        </Panel>
      </section>

      <Panel title="Agent timeline" icon={Brain} className="mt-6">
        <div className="space-y-3">
          {data.timeline.map((e) => (
            <div key={e.id} className="rounded-2xl border border-[var(--line)] bg-white p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                <span>{when(e.createdAt)}</span>
                <span className="rounded-full bg-[#f4f4f5] px-2 py-0.5 font-semibold">{e.desk}</span>
                <span>{e.act ?? 'act unknown'}</span>
                <span>{e.latencyMs}ms</span>
                <span>{e.channel}</span>
              </div>
              <p className="mt-2 text-sm">"{e.heard}"</p>
              {e.reply && <p className="muted mt-1 text-sm">↳ {e.reply}</p>}
              {e.handoffFrom && e.handoffTo && (
                <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-[#eef2ff] px-2 py-1 text-xs font-semibold text-[var(--accent)]">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  handoff {e.handoffFrom} to {e.handoffTo}
                </p>
              )}
            </div>
          ))}
          {data.timeline.length === 0 && <p className="muted text-sm">No agent events recorded yet.</p>}
        </div>
      </Panel>
    </>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase text-[var(--muted)]">{label}</p>
        <Icon className="h-4 w-4 text-[var(--accent)]" />
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums">{value}</p>
      {note && <p className="muted mt-1 text-xs">{note}</p>}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--line)] pb-2">
      <span className="muted">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function Panel({
  title,
  icon: Icon,
  children,
  className = '',
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`pane p-6 ${className}`}>
      <div className="mb-4 flex items-center gap-2">
        <Icon className="h-4 w-4 text-[var(--accent)]" />
        <h2 className="text-sm font-semibold uppercase text-[var(--muted)]">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function ShoppingIcon({ className }: { className?: string }) {
  return <ReceiptText className={className} />;
}

export default function Page() {
  return (
    <Suspense fallback={<IntelSkeleton />}>
      <CustomerDetail />
    </Suspense>
  );
}
