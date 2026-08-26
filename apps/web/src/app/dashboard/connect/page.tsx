'use client';

import { useCallback, useEffect, useState } from 'react';
import { API, get, post } from '@/lib/api';
import { RowsSkeleton } from '@/components/Loading';

interface Connect {
  counterQrUrl: string;
  joinLink: string;
  joinCode: string;
  sandboxNumber: string;
  whatsappNumber: string | null;
  wabaStatus: string;
}

interface Household {
  id: string;
  name: string;
  phone: string;
  memberCount: number;
  autonomyTier: string;
  streak: number;
  orders: number;
}

/**
 * Three blocks, deliberately separated, because they are three different
 * jobs and conflating them is the easiest mistake to make here.
 *
 * FIRST: the customer list. Nothing else on this page matters until a
 * household exists, because inbound routing resolves a customer by
 * (kiranaId, phone) and answers nothing at all when it misses.
 *
 * SECOND: the counter QR, which customers scan to reach this shop's line.
 * Live today, and unchanged in production except for the number behind it.
 *
 * THIRD: connecting the shop's OWN number. That is Meta Coexistence, which
 * needs a Meta Business Account and Meta-side eligibility. Not a ten-day
 * item, so it reads PENDING and says why.
 */
export default function Connect() {
  const [c, setC] = useState<Connect | null>(null);
  const [households, setHouseholds] = useState<Household[] | null>(null);
  const [form, setForm] = useState({ name: '', phone: '' });
  const [err, setErr] = useState<string | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadHouseholds = useCallback(() => {
    get<{ households: Household[] }>('/households')
      .then((r) => setHouseholds(r.households))
      .catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    get<Connect>('/shop/connect').then(setC).catch((e) => setErr(e.message));
    loadHouseholds();
  }, [loadHouseholds]);

  const ready = form.name.trim().length > 1 && form.phone.replace(/\D/g, '').length >= 10;

  async function addHousehold() {
    setBusy(true);
    setAddErr(null);
    try {
      await post('/households', { name: form.name.trim(), phone: form.phone.trim() });
      setForm({ name: '', phone: '' });
      loadHouseholds();
    } catch (e) {
      setAddErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (err) return <p className="text-[var(--warn)]">{err}</p>;
  if (!c) return <RowsSkeleton rows={5} />;

  return (
    <>
      <h1 className="text-2xl font-semibold">WhatsApp</h1>
      <p className="muted mt-1 text-sm">
        Your shop&rsquo;s ordering line. Three things, all separate.
      </p>

      {/* ---------------- customers: the part that makes it work ------- */}
      <div className="panel mt-6 p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-medium">Customers</h2>
          <span className="muted text-xs">
            {households ? `${households.length} registered` : '…'}
          </span>
        </div>

        <p className="muted mt-2 text-sm leading-relaxed">
          A message is only answered if the sender is registered here. Add the
          number exactly as they use it on WhatsApp.
        </p>

        <div className="mt-4 flex flex-wrap gap-3">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Ramesh Sharma"
            aria-label="Customer name"
            className="auth-field min-w-[180px] flex-1 px-3 py-2.5 text-sm"
          />
          <input
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            inputMode="numeric"
            placeholder="98765 43210"
            aria-label="Customer mobile number"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready && !busy) void addHousehold();
            }}
            className="auth-field min-w-[150px] flex-1 px-3 py-2.5 text-sm"
          />
          <button
            onClick={addHousehold}
            disabled={!ready || busy}
            className="rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-black disabled:opacity-40"
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>

        {addErr && <p className="mt-3 text-sm text-[var(--warn)]">{addErr}</p>}

        {households && households.length > 0 && (
          <ul className="mt-5 divide-y divide-[var(--line)] border-t border-[var(--line)]">
            {households.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm">
                <span className="font-medium">{h.name}</span>
                <span className="muted tabular-nums">{h.phone}</span>
                <span className="muted ml-auto text-xs">
                  {h.orders} order{h.orders === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        )}

        {households?.length === 0 && (
          <p className="muted mt-5 border-t border-[var(--line)] pt-4 text-sm">
            No customers yet. Until one is added, messages to the shop go
            unanswered.
          </p>
        )}
      </div>

      {/* ---------------- customer side, live ---------------- */}
      <div className="panel mt-5 p-6">
        <div className="flex flex-wrap items-start gap-8">
          <div className="rounded-lg bg-white p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${API}${c.counterQrUrl}`} alt="counter QR" width={190} height={190} />
          </div>

          <div className="min-w-[260px] flex-1">
            <h2 className="font-medium">The counter QR</h2>
            <p className="muted mt-2 text-sm leading-relaxed">
              Print it and stick it on the counter. A customer scans once, joins
              once, and orders on WhatsApp from then on.
            </p>
            <p className="muted mt-3 text-sm leading-relaxed">
              There is already a QR on that counter for UPI. This is the second
              one. That one takes money, this one takes orders.
            </p>

            <div className="mt-4 flex flex-wrap gap-3">
              <a
                href={`${API}${c.counterQrUrl}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-black"
              >
                Open QR
              </a>
              <button
                onClick={() => window.print()}
                className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm"
              >
                Print
              </button>
            </div>

            <p className="muted mt-4 text-xs">
              Or the customer sends <b className="text-[var(--ink)]">{c.joinCode}</b>{' '}
              to <b className="text-[var(--ink)]">{c.sandboxNumber}</b>.
            </p>
          </div>
        </div>
      </div>

      {/* ---------------- shop side, pending ---------------- */}
      <div className="panel mt-5 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Your own WhatsApp number</h2>
          <span
            className={
              'rounded px-2 py-0.5 text-xs ' +
              (c.wabaStatus === 'CONNECTED'
                ? 'bg-[var(--accent)] text-black'
                : 'border border-[var(--line)] text-[var(--muted)]')
            }
          >
            {c.wabaStatus}
          </span>
        </div>

        <p className="muted mt-3 text-sm leading-relaxed">
          Orders currently arrive on a shared demo number. Connecting your own
          takes Meta Coexistence: you scan a QR from your WhatsApp Business app,
          and the number keeps working inside that app.
        </p>
        <p className="muted mt-2 text-sm leading-relaxed">
          That needs a Meta Business Account, and Meta itself grants permission
          based on how old the account is and how its message quality reads.
        </p>

        <button
          disabled
          className="mt-4 cursor-not-allowed rounded-lg border border-[var(--line)] px-4 py-2 text-sm opacity-50"
        >
          Connect your number
        </button>
      </div>
    </>
  );
}
