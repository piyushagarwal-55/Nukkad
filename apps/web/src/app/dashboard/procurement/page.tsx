'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, patch, post, rupees } from '@/lib/api';
import { Skel } from '@/components/Loading';

interface Supplier { id: string; name: string; phone: string }
interface Line {
  id?: string;
  skuId?: string | null;
  name: string;
  quantity: number;
  why?: string | null;
  inStock: number;
  costPaise?: number | null;
}
interface PurchaseOrder {
  id: string;
  supplierId: string | null;
  status: string;
  reason: string | null;
  amountPaise: number | null;
  sentText: string | null;
  createdAt: string;
  askedAt: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  lines: Line[];
}
interface Payload {
  kirana: { name: string } | null;
  suppliers: Supplier[];
  supplier: Supplier | null;
  order: PurchaseOrder | null;
}

const editable = (status?: string) => !status || status === 'DRAFT' || status === 'AWAITING_OWNER';

const blankLine = (): Line => ({
  name: '',
  quantity: 1,
  why: 'owner added in dashboard',
  inStock: 0,
  costPaise: null,
});

function when(iso?: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

export default function Procurement() {
  const [data, setData] = useState<Payload | null>(null);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await get<Payload>('/procurement');
    setData(next);
    setSupplierId(next.order?.supplierId ?? next.supplier?.id ?? next.suppliers[0]?.id ?? null);
    setLines(next.order?.lines.length ? next.order.lines : []);
  }, []);

  useEffect(() => { load().catch((e) => setNote((e as Error).message)); }, [load]);

  const total = useMemo(() => {
    const known = lines.filter((l) => l.costPaise != null && Number.isFinite(l.quantity));
    return {
      known: known.length,
      paise: known.reduce((sum, l) => sum + (l.costPaise ?? 0) * Number(l.quantity || 0), 0),
    };
  }, [lines]);

  const order = data?.order ?? null;
  const canEdit = editable(order?.status);
  const activeSupplier = data?.suppliers.find((s) => s.id === supplierId) ?? null;

  const updateLine = (idx: number, patchLine: Partial<Line>) => {
    setLines((prev) => prev.map((line, i) => (i === idx ? { ...line, ...patchLine } : line)));
  };

  const draft = async () => {
    setBusy(true);
    setNote(null);
    try {
      const next = await post<Payload>('/procurement/draft');
      setData(next);
      setSupplierId(next.order?.supplierId ?? next.supplier?.id ?? null);
      setLines(next.order?.lines ?? []);
      setNote('Draft ready for owner approval.');
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!order) return;
    setBusy(true);
    setNote(null);
    try {
      const clean = lines
        .map((l) => ({ ...l, name: l.name.trim(), quantity: Number(l.quantity) }))
        .filter((l) => l.name && l.quantity > 0);
      const next = await patch<Payload>(`/procurement/${order.id}`, { supplierId, lines: clean });
      setData(next);
      setLines(next.order?.lines ?? []);
      setNote('Approval rows saved.');
      return next;
    } catch (e) {
      setNote((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!order) return;
    await save();
    setBusy(true);
    setNote(null);
    try {
      const next = await post<Payload & { result: { text: string; sentToSupplier?: boolean } }>(
        `/procurement/${order.id}/send`,
      );
      setData(next);
      setLines(next.order?.lines ?? []);
      setNote(next.result.text);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <>
        <Skel className="h-10 w-72" />
        <Skel className="mt-6 h-72 w-full" />
      </>
    );
  }

  const preview = [
    `Namaste ${activeSupplier?.name ?? 'Supplier'} ji,`,
    `${data.kirana?.name ?? 'Nukkad'} se order hai:`,
    '',
    ...lines
      .filter((l) => l.name.trim() && Number(l.quantity) > 0)
      .map((l, i) => `${i + 1}. ${l.name.trim()} - ${Number(l.quantity)} packet`),
    '',
    'Bill ke saath rate bhej dijiyega. Kab tak pahunch jayega?',
  ].join('\n');

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display text-[clamp(2rem,4vw,2.75rem)]">Procurement Approval</h1>
          <p className="muted mt-2 max-w-2xl text-sm leading-relaxed">
            Low stock se draft banta hai, owner rows check karta hai, phir supplier ko WhatsApp jata hai.
          </p>
        </div>
        <button
          onClick={draft}
          disabled={busy}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {order ? 'Refresh draft' : 'Create draft'}
        </button>
      </div>

      <section className="pane card-in mt-7 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Owner approval</p>
            <p className="mt-1 text-sm font-semibold">
              {order ? `Purchase order ${order.id.slice(-6)}` : 'No draft yet'}
              {order && <span className="muted"> - {order.status.toLowerCase()}</span>}
            </p>
          </div>
          {order?.sentAt && <p className="muted text-xs">Sent {when(order.sentAt)}</p>}
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto]">
          <label>
            <span className="inv-label">Supplier</span>
            <select
              value={supplierId ?? ''}
              onChange={(e) => setSupplierId(e.target.value || null)}
              disabled={!canEdit}
              className="inv-field"
            >
              <option value="">Select supplier</option>
              {data.suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name} - {s.phone}</option>
              ))}
            </select>
          </label>
          <div className="rounded-lg border border-[var(--line)] px-4 py-2">
            <p className="muted text-[11px]">Estimate</p>
            <p className="text-lg font-semibold tabular-nums">
              {total.known ? `Rs ${rupees(Math.round(total.paise))}` : 'No cost basis'}
            </p>
          </div>
        </div>

        {lines.length > 0 ? (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide opacity-60">
                  <th className="py-2 pr-3 font-semibold">Item</th>
                  <th className="py-2 pr-3 font-semibold">Qty</th>
                  <th className="py-2 pr-3 font-semibold">Shelf</th>
                  <th className="py-2 pr-3 font-semibold">Cost</th>
                  <th className="py-2 pr-3 font-semibold">Reason</th>
                  <th className="py-2 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={line.id ?? `new-${idx}`} className="border-b border-[var(--line)]">
                    <td className="py-2 pr-3">
                      <input
                        value={line.name}
                        onChange={(e) => updateLine(idx, { name: e.target.value })}
                        disabled={!canEdit}
                        className="inv-field min-w-[230px]"
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={line.quantity}
                        onChange={(e) => updateLine(idx, { quantity: Number(e.target.value) })}
                        disabled={!canEdit}
                        className="inv-field w-24"
                      />
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{line.inStock}</td>
                    <td className="py-2 pr-3 tabular-nums">
                      {line.costPaise == null ? '-' : `Rs ${rupees(line.costPaise)}`}
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        value={line.why ?? ''}
                        onChange={(e) => updateLine(idx, { why: e.target.value })}
                        disabled={!canEdit}
                        className="inv-field min-w-[230px]"
                      />
                    </td>
                    <td className="py-2">
                      <button
                        disabled={!canEdit}
                        onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                        className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted mt-5 text-sm">Create a draft to pull in low-stock and demand items.</p>
        )}

        {canEdit && (
          <button
            onClick={() => setLines((prev) => [...prev, blankLine()])}
            className="mt-4 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-semibold"
          >
            Add row
          </button>
        )}
      </section>

      <section className="pane card-in mt-6 p-6">
        <p className="text-xs font-semibold uppercase tracking-wide opacity-60">WhatsApp preview</p>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-lg bg-white p-4 text-sm leading-relaxed">
          {lines.length ? preview : 'No message yet.'}
        </pre>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={save}
            disabled={busy || !order || !canEdit || !lines.length}
            className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            Save rows
          </button>
          <button
            onClick={send}
            disabled={busy || !order || !canEdit || !supplierId || !lines.length}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Working...' : 'Approve and send WhatsApp'}
          </button>
          {note && <p className="muted text-sm">{note}</p>}
        </div>
      </section>

      {order?.sentText && (
        <section className="pane card-in mt-6 p-6">
          <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Last sent</p>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-lg bg-white p-4 text-sm leading-relaxed">
            {order.sentText}
          </pre>
        </section>
      )}
    </>
  );
}
