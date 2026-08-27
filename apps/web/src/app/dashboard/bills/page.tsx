'use client';

import { useEffect, useRef, useState } from 'react';
import { API, get, post, rupees } from '@/lib/api';

/**
 * Supplier bill in, reviewed catalogue out.
 *
 * The screen is a REVIEW surface, not a progress bar. The agent proposes;
 * the owner decides. Every proposal shows its evidence -- what it matched,
 * what the runners up were, how sure it is and why -- because an agent that
 * writes to a shop's stock and prices has to be auditable by the person
 * whose shop it is.
 */

interface Step { node: string; status: string; ms: number; note: string | null }
interface Candidate { id: string; name: string; score: number }
interface Line {
  id: string;
  rawName: string;
  quantity: number;
  ratePaise: number;
  amountPaise: number;
  decision: 'RESTOCK' | 'NEW' | 'AMBIGUOUS' | 'SKIPPED';
  confidence: number;
  reasoning: string | null;
  skuId: string | null;
  candidates: { catalogue: Candidate[]; kb: Array<{ canonical: string; brand: string; score: number }> } | null;
  priceDeltaPaise: number | null;
  proposedSellPaise: number | null;
  suggestedAliases: string[];
  disputed: boolean;
  disputeNote: string | null;
  workingName: string | null;
  gloss: string | null;
  unit: string | null;
  pack: string | null;
  mrpPaise: number | null;
  listPricePaise: number | null;
  discPct: number | null;
  taxPct: number | null;
  isFree: boolean;
  derived: string[];
}
interface Plan {
  billId: string;
  status: string;
  docType: string | null;
  supplier: string | null;
  billNo: string | null;
  totalPaise: number | null;
  agentMs: number | null;
  steps: Step[];
  lines: Line[];
}

/** What each node of the graph is for, in one line, for the review screen. */
const NODE_BLURB: Record<string, string> = {
  extract: 'Read the photograph into structured line items',
  retrieve: 'Pulled the nearest catalogue rows and knowledge base entries',
  normalise: 'Transliterated Devanagari and glossed it in English, then checked both routes reach the same product',
  repair: 'Solved for whichever of quantity, rate and amount the bill left blank',
  verify: 'Checked qty x rate against the printed amount, and read it twice where it did not close',
  reconcile: 'Decided restock, new, or too close to call',
  price: 'Compared every rate against what this shop last paid',
  alias: 'Proposed the local names customers will actually say',
  critic: 'Tried to refute each match before trusting it',
  persist: 'Saved the plan for review',
};

const BADGE: Record<Line['decision'], string> = {
  RESTOCK: 'badge-restock', NEW: 'badge-new',
  AMBIGUOUS: 'badge-ambiguous', SKIPPED: 'badge-skipped',
};

/* ------------------------------------------------------------ the trace */
function Trace({ steps, ms }: { steps: Step[]; ms: number | null }) {
  return (
    <div className="pane mt-5 p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="display text-xl">How it read the bill</h2>
        {ms !== null && <span className="muted text-xs tabular-nums">{(ms / 1000).toFixed(1)}s</span>}
      </div>

      <div className="mt-5 space-y-4">
        {steps.map((s, i) => (
          <div
            key={`${s.node}-${i}`}
            data-status={s.status}
            className="node-row node-in"
            style={{ animationDelay: `${i * 90}ms` }}
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-semibold">{s.node}</span>
              <span className="muted text-[11px] tabular-nums">{s.ms}ms</span>
              {s.status !== 'OK' && (
                <span className="badge badge-ambiguous">{s.status.toLowerCase()}</span>
              )}
            </div>
            <p className="muted mt-0.5 text-[12px]">{NODE_BLURB[s.node] ?? ''}</p>
            {s.note && <p className="mt-1 text-[13px]">{s.note}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- one plan line */
function LineCard({
  line, onChange,
}: {
  line: Line;
  onChange: (patch: Partial<Line>) => void;
}) {
  const [openAlias, setOpenAlias] = useState(false);
  const cands = line.candidates?.catalogue ?? [];
  const delta = line.priceDeltaPaise;

  return (
    <div className="border-t border-[#1a1a1a14] px-3 py-4 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{line.rawName}</p>

          {/* what we made of it, when the paper was not in Roman script.
              The original above is never overwritten. */}
          {line.workingName && line.workingName !== line.rawName && (
            <p className="muted mt-0.5 text-xs">
              read as <b className="text-[var(--ink)]">{line.workingName}</b>
              {line.gloss && <> &middot; {line.gloss}</>}
            </p>
          )}

          <p className="muted mt-0.5 text-xs">
            {line.pack && <>{line.pack} &middot; </>}
            {line.isFree ? <b className="text-[var(--green)]">free item</b> : <>{line.quantity}{line.unit ?? ''} &times; &#8377;{rupees(line.ratePaise)}</>}
            {line.mrpPaise ? <> &middot; MRP &#8377;{rupees(line.mrpPaise)}</> : null}
            {/* Exactly 'rate' here, not any derivation starting with it.
                A GST line derives 'rate-from-gst' and gets the full working
                spelled out underneath instead, so the badge would be saying
                the same thing twice and less clearly. */}
            {line.derived.includes('rate') && (
              <span className="badge badge-ambiguous ml-1.5">rate worked out</span>
            )}
            {' = '}&#8377;{rupees(line.amountPaise)}
            {delta !== null && delta !== 0 && (
              <>
                {' · '}
                <span className={delta > 0 ? 'delta-up' : 'delta-down'}>
                  {delta > 0 ? '▲' : '▼'} &#8377;{rupees(Math.abs(delta))} vs last bill
                </span>
              </>
            )}
          </p>

          {/* SHOW THE WORKING.
              The bill prints 400 and the catalogue gets 420, and without
              this line that looks like a mistake rather than the GST it
              actually is. The unit cost is what the shop parted with per
              unit, tax included -- not the pre-tax list price. */}
          {line.listPricePaise !== null && (
            <p className="muted mt-1 text-[11px]">
              bill says list &#8377;{rupees(line.listPricePaise)}
              {line.discPct ? <> &minus; {line.discPct}% disc</> : null}
              {line.taxPct ? <> &plus; {line.taxPct}% GST</> : null}
              {' '}&rarr; <b className="text-[var(--ink)]">&#8377;{rupees(line.ratePaise)}</b> actually paid per unit
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className={`badge ${BADGE[line.decision]}`}>{line.decision.toLowerCase()}</span>
        </div>
      </div>

      {/* a line whose NUMBERS are not trusted. Louder than the reasoning
          line, because this is the one an owner must not skim past. */}
      {line.disputed && line.disputeNote && (
        <div className="mt-2.5 rounded-lg border-2 border-[var(--hot)] bg-[var(--hot)]/8 px-3 py-2">
          <p className="text-[12px] font-semibold text-[var(--hot)]">Check this against the paper</p>
          <p className="mt-0.5 text-[12px]">{line.disputeNote}</p>
        </div>
      )}

      {/* the agent&apos;s reasoning and how sure it was */}
      {line.reasoning && (
        <div className="mt-2.5 flex items-center gap-3">
          <span className="conf-rail w-16 shrink-0">
            <span className="conf-fill block" style={{ width: `${Math.round(line.confidence * 100)}%` }} />
          </span>
          <p className="muted text-[12px] italic">{line.reasoning}</p>
        </div>
      )}

      {/* what the owner can change */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={line.decision === 'NEW' ? 'NEW' : (line.skuId ?? 'NEW')}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'NEW') onChange({ decision: 'NEW', skuId: null });
            else if (v === 'SKIPPED') onChange({ decision: 'SKIPPED', skuId: null });
            else onChange({ decision: 'RESTOCK', skuId: v });
          }}
          className="inv-field !w-auto max-w-[300px] !py-1.5 !text-xs"
        >
          <option value="NEW">Create as a new item</option>
          {cands.map((c) => (
            <option key={c.id} value={c.id}>
              Add stock to: {c.name} ({Math.round(c.score * 100)}%)
            </option>
          ))}
          <option value="SKIPPED">Skip this line</option>
        </select>

        <label className="muted flex items-center gap-1.5 text-xs">
          sell &#8377;
          <input
            type="number"
            step="any"
            min="0"
            value={(line.proposedSellPaise ?? 0) / 100}
            onChange={(e) => onChange({ proposedSellPaise: Math.round(Number(e.target.value) * 100) })}
            className="inv-field !w-20 !py-1.5 !text-xs"
          />
        </label>

        {line.suggestedAliases.length > 0 && (
          <button onClick={() => setOpenAlias((v) => !v)} className="muted text-xs underline">
            {line.suggestedAliases.length} subnames
          </button>
        )}
      </div>

      {openAlias && (
        <div className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--bg)] p-3">
          <p className="muted mb-2 text-[11px]">
            Retrieved from the product knowledge base, not invented. Untick anything wrong.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {line.suggestedAliases.map((a) => (
              <button
                key={a}
                onClick={() => onChange({ suggestedAliases: line.suggestedAliases.filter((x) => x !== a) })}
                className="chip chip-x"
                title="Remove"
              >
                {a} <span className="opacity-40">&times;</span>
              </button>
            ))}
            {line.suggestedAliases.length === 0 && (
              <span className="muted text-xs">none left</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- the page */
export default function Bills() {
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: number; restocked: number; skipped: number; aliasesAdded: number } | null>(null);
  const [confirmRetail, setConfirmRetail] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDone(null); }, [plan?.billId]);

  async function upload() {
    if (!file) return;
    setBusy(true); setErr(null); setPlan(null); setDone(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // multipart, so no JSON helper; the session cookie still has to ride along
      const res = await fetch(`${API}/bills/parse`, { method: 'POST', body: fd, credentials: 'include' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `upload failed (${res.status})`);
      setPlan(body as Plan);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  function patchLine(id: string, patch: Partial<Line>) {
    setPlan((p) => p && { ...p, lines: p.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  }

  async function commit() {
    if (!plan) return;
    setBusy(true); setErr(null);
    try {
      const r = await post<{ created: number; restocked: number; skipped: number; aliasesAdded: number }>(
        `/bills/${plan.billId}/commit`,
        {
          confirmPurchase: confirmRetail,
          lines: plan.lines.map((l) => ({
            id: l.id,
            decision: l.decision,
            skuId: l.skuId,
            sellPaise: l.proposedSellPaise ?? undefined,
            aliases: l.suggestedAliases,
          })),
        },
      );
      setDone(r);
      setPlan(null);
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  const counts = plan
    ? {
        restock: plan.lines.filter((l) => l.decision === 'RESTOCK').length,
        neu: plan.lines.filter((l) => l.decision === 'NEW').length,
        ask: plan.lines.filter((l) => l.decision === 'AMBIGUOUS').length,
      }
    : null;

  return (
    <>
      <h1 className="display text-[clamp(2rem,4vw,2.75rem)]">Bill upload</h1>
      <p className="muted mt-2 max-w-xl text-sm leading-relaxed">
        Photograph a supplier bill. It is read, matched against what you
        already stock, checked for price changes, and given the local names
        customers use. You approve before anything is written.
      </p>

      {/* ---- upload ---- */}
      <div className="pane-ink mt-7 p-6">
        <div className="flex flex-wrap items-center gap-4">
          <input
            ref={inputRef}
            type="file"
            accept="image/*,application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="max-w-full text-sm text-[var(--bg)] file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--accent)] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-[var(--ink)]"
          />
          <button
            onClick={upload}
            disabled={!file || busy}
            className="rounded-lg border-2 border-[var(--bg)] bg-[var(--bg)] px-4 py-2 text-sm font-semibold text-[var(--ink)] disabled:opacity-35"
          >
            {busy && !plan ? 'Reading…' : 'Read the bill'}
          </button>
        </div>
        {busy && !plan && (
          <p className="mt-4 text-xs text-[var(--bg)]/55">
            Running the graph: extract, retrieve, reconcile, price, subnames, check.
          </p>
        )}
      </div>

      {err && (
        <p className="mt-5 rounded-lg border-2 border-[var(--hot)] bg-[var(--hot)]/10 px-4 py-3 text-sm text-[var(--hot)]">
          {err}
        </p>
      )}

      {done && (
        <div className="pane card-in mt-5 bg-[var(--panel)] p-6">
          <h2 className="display text-xl">Applied</h2>
          <p className="muted mt-2 text-sm">
            {done.restocked} restocked &middot; {done.created} created &middot;{' '}
            {done.skipped} skipped &middot; {done.aliasesAdded} subnames added.
          </p>
        </div>
      )}

      {plan && (
        <>
          {/* THE DIRECTION CHECK. A retail receipt is a sale: those goods
              left the shelf. Applying it as a delivery adds stock that was
              just sold, and nothing catches it until the shelf and the
              screen disagree. */}
          {plan.docType === 'RETAIL' && (
            <div className="mt-5 rounded-xl border-2 border-[var(--ink)] bg-[var(--amber)] p-5 shadow-[4px_4px_0_var(--ink)]">
              <h2 className="display text-xl">This looks like a retail receipt</h2>
              <p className="mt-2 text-sm leading-relaxed">
                A retail bill is usually a <b>sale</b> — those goods left the
                shelf — and applying it would <b>add</b> stock you just sold.
                If you bought these from a cash-and-carry, that is a purchase
                and this is fine. Only you know which.
              </p>
              <label className="mt-4 flex items-center gap-2.5 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={confirmRetail}
                  onChange={(e) => setConfirmRetail(e.target.checked)}
                  className="h-4 w-4"
                />
                Yes, I bought these. Add them to my stock.
              </label>
            </div>
          )}

          <Trace steps={plan.steps} ms={plan.agentMs} />

          <div className="pane mt-5 p-2">
            <div className="flex flex-wrap items-baseline justify-between gap-3 px-3 pt-3 pb-1">
              <h2 className="display text-xl">
                {plan.supplier ?? 'The bill'}
                {plan.billNo && <span className="muted ml-2 text-sm">#{plan.billNo}</span>}
              </h2>
              {counts && (
                <p className="muted text-xs">
                  {counts.restock} restock &middot; {counts.neu} new
                  {counts.ask > 0 && <span className="text-[var(--warn)]"> &middot; {counts.ask} need you</span>}
                </p>
              )}
            </div>

            {plan.lines.map((l) => (
              <LineCard key={l.id} line={l} onChange={(p) => patchLine(l.id, p)} />
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              onClick={commit}
              disabled={busy || (plan.docType === 'RETAIL' && !confirmRetail)}
              className="rounded-lg border-2 border-[var(--ink)] bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold shadow-[4px_4px_0_var(--ink)] disabled:opacity-40"
            >
              {busy ? 'Applying…' : 'Apply to catalogue'}
            </button>
            <button onClick={() => setPlan(null)} className="muted text-sm hover:text-[var(--ink)]">
              Discard
            </button>
            {counts && counts.ask > 0 && (
              <p className="muted text-xs">
                Lines marked <b>ambiguous</b> are skipped unless you pick a match above.
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}
