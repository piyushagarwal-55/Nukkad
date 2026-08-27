'use client';

import { useCallback, useEffect, useState } from 'react';
import { API, get, post } from '@/lib/api';
import { RowsSkeleton } from '@/components/Loading';

/**
 * The WhatsApp page.
 *
 * Three different jobs live here and conflating them is the easiest mistake
 * to make, so they stay visibly separate:
 *
 *   IS IT LIVE      three things must be true or messages vanish silently
 *   CUSTOMERS       inbound routing resolves by number; no row, no answer
 *   THE TWO NUMBERS the counter QR customers scan, and the shop's own line
 *
 * The readiness panel is first because every one of its failures looks
 * identical from the outside -- silence -- and an owner cannot tell them
 * apart without being told.
 */

interface Check { key: string; ok: boolean; label: string; detail: string }
interface Connect {
  live: boolean;
  checks: Check[];
  counts: { households: number; skus: number };
  counterQrUrl: string;
  joinLink: string;
  joinCode: string;
  sandboxNumber: string;
  whatsappNumber: string | null;
  wabaStatus: string;
}
interface Household {
  id: string; name: string; phone: string;
  memberCount: number; autonomyTier: string; streak: number; orders: number;
}

const TIER: Record<string, string> = {
  MANUAL: 'waits to be asked',
  SUGGESTED: 'proposes, they confirm',
  STANDING: 'orders, they may veto',
  SILENT: 'orders under a cap',
};

export default function Connect() {
  const [c, setC] = useState<Connect | null>(null);
  const [households, setHouseholds] = useState<Household[] | null>(null);
  const [form, setForm] = useState({ name: '', phone: '' });
  const [err, setErr] = useState<string | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    get<Connect>('/shop/connect').then(setC).catch((e) => setErr(e.message));
    get<{ households: Household[] }>('/households')
      .then((r) => setHouseholds(r.households))
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  const ready = form.name.trim().length > 1 && form.phone.replace(/\D/g, '').length >= 10;

  async function addHousehold() {
    setBusy(true);
    setAddErr(null);
    try {
      await post('/households', { name: form.name.trim(), phone: form.phone.trim() });
      setForm({ name: '', phone: '' });
      load();
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
      <h1 className="display text-[clamp(2rem,4vw,2.75rem)]">WhatsApp</h1>
      <p className="muted mt-2 max-w-xl text-sm leading-relaxed">
        Your shop&rsquo;s ordering line. Customers message the number, the shop
        answers, and everything they say lands in Orders.
      </p>

      {/* ---- is it actually live ---- */}
      <section
        className={`card-in mt-7 rounded-[18px] border-2 border-[var(--ink)] p-6 ${
          c.live ? 'bg-[var(--green)] text-[var(--panel)]' : 'bg-[var(--amber)]'
        }`}
        style={{ boxShadow: '4px 4px 0 var(--ink)' }}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="display text-2xl">
            {c.live ? 'The line is live' : 'The line is not live yet'}
          </h2>
          <span className="text-xs opacity-70">
            {c.checks.filter((x) => x.ok).length} of {c.checks.length} ready
          </span>
        </div>

        <ul className="mt-5 space-y-3">
          {c.checks.map((k) => (
            <li key={k.key} className="flex gap-3">
              <span
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-[var(--ink)] text-[11px] font-bold ${
                  k.ok ? 'bg-[var(--panel)] text-[var(--ink)]' : 'bg-[var(--hot)] text-[var(--bg)]'
                }`}
              >
                {k.ok ? '✓' : '!'}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{k.label}</span>
                <span className="block text-[12px] leading-relaxed opacity-80">{k.detail}</span>
              </span>
            </li>
          ))}
        </ul>

        {!c.live && (
          <p className="mt-5 border-t border-[var(--ink)]/20 pt-4 text-[12px] leading-relaxed">
            Each of these fails the same way from the outside: the customer sends
            a message and nothing comes back. That is why they are listed
            separately rather than as one status light.
          </p>
        )}
      </section>

      {/* ---- customers ---- */}
      <section className="pane card-in mt-5 p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="display text-xl">Customers</h2>
          <span className="muted text-xs">
            {households ? `${households.length} registered` : '…'}
          </span>
        </div>
        <p className="muted mt-1.5 text-[13px] leading-relaxed">
          A message is only answered if the sender is on this list. Add the number
          exactly as they use it on WhatsApp.
        </p>

        <div className="mt-4 flex flex-wrap gap-2.5">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Ramesh Sharma"
            aria-label="Customer name"
            className="inv-field min-w-[170px] flex-1"
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
            className="inv-field min-w-[140px] flex-1"
          />
          <button
            onClick={addHousehold}
            disabled={!ready || busy}
            className="rounded-lg border-2 border-[var(--ink)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold shadow-[3px_3px_0_var(--ink)] disabled:opacity-40"
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>

        {addErr && <p className="mt-3 text-sm text-[var(--warn)]">{addErr}</p>}

        {households && households.length > 0 && (
          <ul className="mt-5 divide-y divide-[#1a1a1a12] border-t border-[#1a1a1a12]">
            {households.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{h.name}</span>
                  <span className="muted block text-xs tabular-nums">
                    {h.phone} &middot; {h.memberCount} people
                  </span>
                </span>
                <span className="muted text-[11px] italic">
                  agent {TIER[h.autonomyTier] ?? h.autonomyTier.toLowerCase()}
                </span>
                <span className="muted ml-auto text-xs tabular-nums">
                  {h.orders} order{h.orders === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        )}

        {households?.length === 0 && (
          <p className="muted mt-5 border-t border-[#1a1a1a12] pt-4 text-sm">
            Nobody yet. Until one number is added, every message goes unanswered.
          </p>
        )}
      </section>

      {/* ---- the two numbers ---- */}
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section className="pane card-in p-6">
          <h2 className="display text-xl">The counter QR</h2>
          <p className="muted mt-1.5 text-[13px] leading-relaxed">
            Print it and stick it on the counter. A customer scans once, joins
            once, and orders on WhatsApp from then on.
          </p>

          <div className="mt-5 flex flex-wrap items-start gap-5">
            <div className="rounded-xl border-2 border-[var(--ink)] bg-white p-2.5 shadow-[4px_4px_0_var(--ink)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${API}${c.counterQrUrl}`} alt="counter QR" width={150} height={150} />
            </div>

            <div className="min-w-[180px] flex-1">
              <p className="text-[13px] leading-relaxed">
                There is already a QR on that counter for UPI. This is the second
                one. <b>That one takes money, this one takes orders.</b>
              </p>

              <div className="mt-4 flex flex-wrap gap-2.5">
                <a
                  href={`${API}${c.counterQrUrl}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border-2 border-[var(--ink)] bg-[var(--accent)] px-3.5 py-2 text-xs font-semibold shadow-[3px_3px_0_var(--ink)]"
                >
                  Open
                </a>
                <button
                  onClick={() => window.print()}
                  className="rounded-lg border-2 border-[var(--ink)] px-3.5 py-2 text-xs font-semibold"
                >
                  Print
                </button>
              </div>
            </div>
          </div>

          <div className="mt-5 rounded-lg border border-[var(--line-2)] bg-[var(--bg)] p-3">
            <p className="muted text-[11px]">Or by hand, if they cannot scan:</p>
            <p className="mt-1.5 text-[13px]">
              send <b>{c.joinCode}</b> to <b className="tabular-nums">{c.sandboxNumber}</b>
            </p>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(`${c.joinCode} → ${c.sandboxNumber}`);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
              className="muted mt-2 text-[11px] underline hover:text-[var(--hot)]"
            >
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
        </section>

        <section className="pane card-in p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="display text-xl">Your own number</h2>
            <span
              className={`ost ${c.wabaStatus === 'CONNECTED' ? 'ost-fulfilled' : 'ost-awaiting'}`}
            >
              {c.wabaStatus.toLowerCase()}
            </span>
          </div>

          <p className="muted mt-3 text-[13px] leading-relaxed">
            Orders currently arrive on a shared demo number. Connecting your own
            takes <b className="text-[var(--ink)]">Meta Coexistence</b>: you scan a
            QR from your WhatsApp Business app, and the number keeps working
            inside that app exactly as it does now.
          </p>
          <p className="muted mt-3 text-[13px] leading-relaxed">
            It needs a Meta Business Account, and Meta itself grants permission
            based on how old the account is and how its message quality reads.
            That is their call and not a setting here.
          </p>

          <div className="mt-5 rounded-lg border border-[var(--hot)]/40 bg-[var(--hot)]/8 p-3">
            <p className="text-[12px] leading-relaxed">
              Never connect a number by scanning a WhatsApp Web QR through an
              unofficial library. It breaches the terms and gets numbers banned,
              which for a kirana means losing the line their customers already
              use.
            </p>
          </div>

          <button
            disabled
            className="mt-5 w-full cursor-not-allowed rounded-lg border-2 border-[var(--line-2)] px-4 py-2.5 text-sm font-semibold opacity-45"
          >
            Connect your number
          </button>
        </section>
      </div>
    </>
  );
}
