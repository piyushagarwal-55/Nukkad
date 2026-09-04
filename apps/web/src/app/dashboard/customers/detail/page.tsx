'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  BadgeIndianRupee,
  Brain,
  CalendarClock,
  Clock3,
  MessageSquareText,
  PhoneCall,
  Radar,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  X,
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
  const [modal, setModal] = useState<{ title: string; body: React.ReactNode } | null>(null);

  useEffect(() => {
    if (!id) return;
    get<Detail>(`/intel/customer/detail?householdId=${encodeURIComponent(id)}`)
      .then(setData)
      .catch(() => setErr('Customer detail load nahi hui.'));
  }, [id]);

  const topTracked = useMemo(() => data?.tracked.slice(0, 6) ?? [], [data]);
  const topFrequent = useMemo(() => data?.frequent.slice(0, 6) ?? [], [data]);
  const topUnmet = useMemo(() => data?.unmetDemand.slice(0, 5) ?? [], [data]);
  const topOrders = useMemo(() => data?.recentOrders.slice(0, 5) ?? [], [data]);
  const topNudges = useMemo(() => data?.nudges.slice(0, 5) ?? [], [data]);

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
  const careCall = data.careCall;

  return (
    <>
      <Link href="/dashboard/customers" className="muted inline-flex items-center gap-2 text-sm">
        <ArrowLeft className="h-4 w-4" />
        Customers
      </Link>

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-[1fr_320px]">
        <section className="overflow-hidden rounded-[20px] bg-[#eef2ff] shadow-[0_18px_48px_-30px_rgba(79,70,229,0.65)]">
          <div className="px-6 py-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-[clamp(1.8rem,3.4vw,2.45rem)] font-semibold leading-tight">{c.name}</h1>
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

          <div className="grid gap-3 bg-white/70 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric tone="violet" icon={ReceiptText} label="Orders" value={c.orders.toLocaleString('en-IN')} />
            <Metric tone="green" icon={BadgeIndianRupee} label="Total spend" value={rupees(c.spendPaise)} />
            <Metric tone="amber" icon={TrendingUp} label="Avg basket" value={rupees(c.avgBasketPaise)} />
            <Metric
              tone="pink"
              icon={CalendarClock}
              label="Order rhythm"
              value={c.medianGapDays ? `${c.medianGapDays}d` : 'learning'}
              note={c.daysSinceLast !== null ? `last ${c.daysSinceLast}d ago` : undefined}
            />
          </div>
        </section>

        <section className="rounded-[20px] bg-[#ecfdf5] p-5 shadow-[0_18px_46px_-32px_rgba(4,120,87,0.5)]">
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

      <section className="mt-6 rounded-[20px] bg-[#fffbeb] p-5 shadow-[0_18px_46px_-34px_rgba(245,158,11,0.55)]">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[var(--accent)]" />
          <h2 className="text-sm font-semibold uppercase text-[var(--muted)]">AI summary</h2>
        </div>
        <p className="mt-3 text-[15px] leading-7">{data.summary}</p>
        {data.opportunity && (
          <p className="mt-3 rounded-xl bg-[#eef2ff] px-4 py-3 text-sm leading-6">
            {data.opportunity}
          </p>
        )}
      </section>

      <section className="mt-6 grid items-start gap-6 lg:grid-cols-[1fr_360px]">
        <div className="rounded-[20px] bg-[#f7f7ff] p-5 shadow-[0_16px_42px_-32px_rgba(79,70,229,0.5)]">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-[var(--accent)]" />
              <h2 className="text-sm font-semibold uppercase text-[var(--muted)]">
                Item depletion tracking
              </h2>
            </div>
            {data.tracked.length > topTracked.length && (
              <button
                onClick={() => setModal({ title: 'Item depletion tracking', body: <TrackedList items={data.tracked} /> })}
                className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-[var(--accent)] shadow-sm"
              >
                More
              </button>
            )}
          </div>

          <div className="mt-5 space-y-3">
            {topTracked.map((item) => (
              <div key={item.skuId} className="rounded-2xl bg-white p-4 shadow-sm">
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

        <aside className="rounded-[20px] bg-[#fef2f2] p-5 shadow-[0_18px_46px_-34px_rgba(220,38,38,0.45)]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <PhoneCall className="h-4 w-4 text-[var(--accent)]" />
              <h2 className="text-sm font-semibold uppercase text-[var(--muted)]">Care-call plan</h2>
            </div>
            {careCall && (
              <button
                onClick={() => setModal({ title: 'Care-call plan', body: <CareCallModal careCall={careCall} /> })}
                className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-[var(--accent)] shadow-sm"
              >
                More
              </button>
            )}
          </div>

          {careCall ? (
            <>
              <div className="mt-4 space-y-2">
                {careCall.lines.slice(0, 4).map((line) => (
                  <div key={line.skuId} className="rounded-xl bg-white px-3 py-2 shadow-sm">
                    <p className="text-sm font-semibold">{line.name}</p>
                    <p className="muted mt-0.5 text-xs">
                      {line.daysSincePurchase !== null ? `${line.daysSincePurchase}d since purchase` : 'no purchase date'}
                      {line.quantityHint !== null ? ` · qty hint ${line.quantityHint}` : ''}
                    </p>
                  </div>
                ))}
              </div>
              {careCall.offer && (
                <p className="mt-4 rounded-xl bg-[#ecfdf5] px-3 py-2 text-sm text-[#047857]">
                  {careCall.offer.title}
                </p>
              )}
              <div className="mt-4 max-h-[132px] overflow-hidden rounded-2xl bg-[#18181b] p-4 text-xs leading-5 text-white">
                {careCall.openingScript}
              </div>
            </>
          ) : (
            <p className="muted mt-4 text-sm">No item is inside the current care-call window.</p>
          )}
        </aside>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel
          title="Frequent basket"
          icon={ShoppingIcon}
          count={data.frequent.length}
          onMore={data.frequent.length > topFrequent.length
            ? () => setModal({ title: 'Frequent basket', body: <FrequentList items={data.frequent} /> })
            : undefined}
        >
          <div className="flex flex-wrap gap-2">
            {topFrequent.map((f) => (
              <span key={f.name} className="rounded-full bg-white px-3 py-1.5 text-sm shadow-sm">
                {f.name} · <b>{f.times}x</b>
              </span>
            ))}
            {data.frequent.length === 0 && <p className="muted text-sm">No purchased items yet.</p>}
          </div>
        </Panel>

        <Panel
          title="Unmet demand"
          icon={MessageSquareText}
          tone="amber"
          count={data.unmetDemand.length}
          onMore={data.unmetDemand.length > topUnmet.length
            ? () => setModal({ title: 'Unmet demand', body: <UnmetList items={data.unmetDemand} /> })
            : undefined}
        >
          <div className="space-y-3">
            {topUnmet.map((u) => (
              <div key={u.id} className="rounded-xl bg-white px-3 py-2 shadow-sm">
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
        <Panel
          title="Recent orders"
          icon={ReceiptText}
          tone="green"
          count={data.recentOrders.length}
          onMore={data.recentOrders.length > topOrders.length
            ? () => setModal({ title: 'Recent orders', body: <OrderList orders={data.recentOrders} /> })
            : undefined}
        >
          <div className="space-y-4">
            <OrderList orders={topOrders} compact />
            {data.recentOrders.length === 0 && <p className="muted text-sm">No orders yet.</p>}
          </div>
        </Panel>

        <Panel
          title="Nudges"
          icon={Clock3}
          tone="pink"
          count={data.nudges.length}
          onMore={data.nudges.length > topNudges.length
            ? () => setModal({ title: 'Nudges', body: <NudgeList nudges={data.nudges} /> })
            : undefined}
        >
          <div className="space-y-3">
            <NudgeList nudges={topNudges} />
            {data.nudges.length === 0 && <p className="muted text-sm">No proactive nudge sent yet.</p>}
          </div>
        </Panel>
      </section>

      {modal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4 backdrop-blur-sm">
          <section className="max-h-[82vh] w-full max-w-3xl overflow-hidden rounded-[22px] bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-4 bg-[#f7f7ff] px-5 py-4">
              <h2 className="text-base font-semibold">{modal.title}</h2>
              <button
                onClick={() => setModal(null)}
                className="grid h-9 w-9 place-items-center rounded-full bg-white text-[var(--muted)] shadow-sm hover:text-[var(--ink)]"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-5">{modal.body}</div>
          </section>
        </div>
      )}
    </>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  note,
  tone = 'violet',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  note?: string;
  tone?: 'violet' | 'green' | 'amber' | 'pink';
}) {
  const tones = {
    violet: 'border-[#c7d2fe] bg-[#eef2ff]',
    green: 'border-[#bbf7d0] bg-[#ecfdf5]',
    amber: 'border-[#fde68a] bg-[#fffbeb]',
    pink: 'border-[#fbcfe8] bg-[#fdf2f8]',
  };

  return (
    <div className={`min-w-0 rounded-2xl p-4 shadow-sm ${tones[tone]}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase text-[var(--muted)]">{label}</p>
        <Icon className="h-4 w-4 text-[var(--accent)]" />
      </div>
      <p className="mt-3 break-words text-[clamp(1.35rem,2.3vw,1.75rem)] font-semibold leading-tight tabular-nums">{value}</p>
      {note && <p className="muted mt-1 text-xs">{note}</p>}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-black/10 pb-2">
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
  count,
  onMore,
  tone = 'violet',
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  className?: string;
  count?: number;
  onMore?: () => void;
  tone?: 'violet' | 'green' | 'amber' | 'pink';
}) {
  const tones = {
    violet: 'bg-[#f7f7ff]',
    green: 'bg-[#f0fdf4]',
    amber: 'bg-[#fffbeb]',
    pink: 'bg-[#fdf2f8]',
  };

  return (
    <section className={`overflow-hidden rounded-[20px] shadow-[0_16px_42px_-32px_rgba(24,24,27,0.45)] ${tones[tone]} ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-black/5 px-6 py-4">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-[var(--accent)]" />
          <h2 className="text-sm font-semibold uppercase text-[var(--muted)]">{title}</h2>
          {count !== undefined && (
            <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs font-semibold text-[var(--muted)]">
              {count}
            </span>
          )}
        </div>
        {onMore && (
          <button
            onClick={onMore}
            className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-[var(--accent)] shadow-sm"
          >
            More
          </button>
        )}
      </div>
      <div className="p-6">{children}</div>
    </section>
  );
}

function TrackedList({ items }: { items: Detail['tracked'] }) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div key={item.skuId} className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
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
    </div>
  );
}

function FrequentList({ items }: { items: Detail['frequent'] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((f) => (
        <span key={f.name} className="rounded-full bg-white px-3 py-1.5 text-sm shadow-sm">
          {f.name} · <b>{f.times}x</b> · {f.units} units
        </span>
      ))}
    </div>
  );
}

function UnmetList({ items }: { items: Detail['unmetDemand'] }) {
  return (
    <div className="space-y-3">
      {items.map((u) => (
        <div key={u.id} className="rounded-xl bg-white px-3 py-2 shadow-sm">
          <p className="text-sm font-semibold">"{u.query}"</p>
          <p className="muted mt-1 text-xs">
            {when(u.createdAt)}{u.offered ? ` · offered ${u.offered}` : ''} · score {u.confidence.toFixed(2)}
          </p>
        </div>
      ))}
    </div>
  );
}

function OrderList({ orders, compact = false }: { orders: Detail['recentOrders']; compact?: boolean }) {
  return (
    <div className="space-y-4">
      {orders.map((order) => (
        <div key={order.id} className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">{when(order.createdAt)}</p>
              <p className="muted text-xs">{order.status} · {order.source}</p>
            </div>
            <p className="font-semibold tabular-nums">{rupees(order.totalPaise)}</p>
          </div>
          <div className="mt-3 space-y-2">
            {order.lines.slice(0, compact ? 4 : undefined).map((line, idx) => (
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
    </div>
  );
}

function NudgeList({ nudges }: { nudges: Detail['nudges'] }) {
  return (
    <div className="space-y-3">
      {nudges.map((nudge) => (
        <div key={nudge.id} className="rounded-xl bg-white px-3 py-2 shadow-sm">
          <p className="text-sm font-semibold">{nudge.templateName.replace(/_/g, ' ')}</p>
          <p className="muted mt-1 text-xs">
            {when(nudge.sentAt)} · {nudge.outcome ?? 'waiting'}
          </p>
        </div>
      ))}
    </div>
  );
}

function CareCallModal({ careCall }: { careCall: NonNullable<Detail['careCall']> }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {careCall.lines.map((line) => (
          <div key={line.skuId} className="rounded-2xl bg-[#fef2f2] p-4 shadow-sm">
            <p className="text-sm font-semibold">{line.name}</p>
            <p className="muted mt-1 text-xs">
              {line.daysSincePurchase !== null ? `${line.daysSincePurchase}d since purchase` : 'no purchase date'}
              {line.quantityHint !== null ? ` · qty hint ${line.quantityHint}` : ''}
            </p>
            <p className="muted mt-1 text-xs">{line.reason.replace(/_/g, ' ').toLowerCase()}</p>
          </div>
        ))}
      </div>

      {careCall.offer && (
        <div className="rounded-2xl bg-[#ecfdf5] p-4 text-sm font-medium text-[#047857]">
          {careCall.offer.title}
        </div>
      )}

      <div className="rounded-2xl bg-[#18181b] p-5 text-sm leading-7 text-white">
        {careCall.openingScript}
      </div>
    </div>
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
