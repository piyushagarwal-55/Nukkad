'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { get, patch, post, del, rupees } from '@/lib/api';
import { RowsSkeleton } from '@/components/Loading';

/**
 * The inventory surface.
 *
 * Still a CORRECTION surface first -- nobody types 400 SKUs by hand, they
 * arrive from a supplier bill -- but a shop always has the handful of
 * things no bill covers, and a parser always gets a few names wrong. So
 * every field is editable here, rows can be added by hand, and anything
 * can be removed.
 */

interface Alias { id: string; alias: string }
interface Sku {
  id: string;
  name: string;
  brand: string | null;
  packSize: number;
  unit: string;
  category: string | null;
  sellPaise: number;
  costPaise: number | null;
  stock: number;
  active: boolean;
  orderCount: number;
  aliases: Alias[];
  suggested: Alias[];
}

const UNITS = ['kg', 'g', 'l', 'ml', 'pkt', 'pc', 'dz', 'btl'];
const LOW_STOCK = 5;

/** rupees in the input, paise on the wire */
const toPaise = (v: string) => Math.round(Number(v || 0) * 100);
const toRupee = (p: number | null) => (p === null ? '' : String(p / 100));

/* ------------------------------------------------------------- alias bar */
function Aliases({ sku, reload }: { sku: Sku; reload: () => void }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  async function add() {
    const alias = draft.trim();
    if (!alias) return;
    setDraft('');
    setAdding(false);
    await post(`/catalogue/${sku.id}/aliases`, { alias });
    reload();
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sku.aliases.map((a) => (
        <span
          key={a.id}
          className="chip chip-x group"
          title="Remove this name"
          onClick={async (e) => {
            e.stopPropagation();
            await del(`/aliases/${a.id}`);
            reload();
          }}
        >
          {a.alias}
          <span className="ml-1 opacity-40 group-hover:opacity-100">&times;</span>
        </span>
      ))}

      {sku.suggested.map((a) => (
        <button
          key={a.id}
          className="chip-suggest"
          title="We suggested this. Tap to accept."
          onClick={async (e) => {
            e.stopPropagation();
            await post(`/aliases/${a.id}/approve`);
            reload();
          }}
        >
          + {a.alias}
        </button>
      ))}

      {adding ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
            if (e.key === 'Escape') { setDraft(''); setAdding(false); }
          }}
          placeholder="peela tel"
          className="inv-field !w-28 !py-0.5 !text-xs"
        />
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); setAdding(true); }}
          className="muted px-1 text-xs hover:text-[var(--hot)]"
          title="Add a name customers use"
        >
          + name
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- the editor */
type Draft = {
  name: string; brand: string; packSize: string; unit: string;
  category: string; sell: string; cost: string; stock: string;
};

function Editor({
  sku, onDone, reload,
}: {
  sku: Sku; onDone: () => void; reload: () => void;
}) {
  const [d, setD] = useState<Draft>({
    name: sku.name,
    brand: sku.brand ?? '',
    packSize: String(sku.packSize),
    unit: sku.unit,
    category: sku.category ?? '',
    sell: toRupee(sku.sellPaise),
    cost: toRupee(sku.costPaise),
    stock: String(sku.stock),
  });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setD({ ...d, [k]: e.target.value });

  async function save() {
    setBusy(true); setErr(null);
    try {
      await patch(`/catalogue/${sku.id}`, {
        name: d.name.trim(),
        brand: d.brand.trim() || null,
        packSize: Number(d.packSize) || 1,
        unit: d.unit,
        category: d.category.trim() || null,
        sellPaise: toPaise(d.sell),
        costPaise: d.cost.trim() === '' ? null : toPaise(d.cost),
        stock: Number(d.stock) || 0,
      });
      reload();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setErr(null);
    try {
      await del(`/catalogue/${sku.id}`);
      reload();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t border-[var(--line)] pt-4" onClick={(e) => e.stopPropagation()}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <label className="inv-label">Item name</label>
          <input value={d.name} onChange={set('name')} className="inv-field" />
        </div>
        <div>
          <label className="inv-label">Brand</label>
          <input value={d.brand} onChange={set('brand')} placeholder="—" className="inv-field" />
        </div>
        <div>
          <label className="inv-label">Category</label>
          <input value={d.category} onChange={set('category')} placeholder="—" className="inv-field" />
        </div>

        <div>
          <label className="inv-label">Pack size</label>
          <input type="number" step="any" min="0" value={d.packSize} onChange={set('packSize')} className="inv-field" />
        </div>
        <div>
          <label className="inv-label">Unit</label>
          <select value={d.unit} onChange={set('unit')} className="inv-field">
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div>
          <label className="inv-label">Selling price (&#8377;)</label>
          <input type="number" step="any" min="0" value={d.sell} onChange={set('sell')} className="inv-field" />
        </div>
        <div>
          <label className="inv-label">Cost price (&#8377;)</label>
          <input type="number" step="any" min="0" value={d.cost} onChange={set('cost')} placeholder="—" className="inv-field" />
        </div>

        <div>
          <label className="inv-label">Stock</label>
          <input type="number" step="any" min="0" value={d.stock} onChange={set('stock')} className="inv-field" />
        </div>

        <div className="flex items-end">
          <button
            onClick={async () => {
              await patch(`/catalogue/${sku.id}`, { active: !sku.active });
              reload();
            }}
            className="inv-field text-left hover:border-[var(--ink)]"
          >
            {sku.active ? 'Visible to customers' : 'Hidden'}
          </button>
        </div>
      </div>

      {err && <p className="mt-3 text-sm text-[var(--warn)]">{err}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <button
          onClick={save}
          disabled={busy || !d.name.trim()}
          className="rounded-lg border-2 border-[var(--ink)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold shadow-[3px_3px_0_var(--ink)] disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onDone} className="muted px-2 text-sm hover:text-[var(--ink)]">
          Cancel
        </button>

        <div className="ml-auto flex items-center gap-2.5">
          {confirm ? (
            <>
              {/* the count matters: deleting detaches real history */}
              <span className="text-xs text-[var(--warn)]">
                {sku.orderCount > 0
                  ? `Used in ${sku.orderCount} past order line${sku.orderCount === 1 ? '' : 's'}. Delete anyway?`
                  : 'Delete this item?'}
              </span>
              <button
                onClick={remove}
                disabled={busy}
                className="rounded-lg border-2 border-[var(--ink)] bg-[var(--hot)] px-3 py-1.5 text-sm font-semibold text-[var(--bg)]"
              >
                Delete
              </button>
              <button onClick={() => setConfirm(false)} className="muted text-sm">
                Keep
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirm(true)}
              className="text-sm text-[var(--warn)] hover:underline"
            >
              Delete item
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ add new row */
function AddRow({ onClose, reload }: { onClose: () => void; reload: () => void }) {
  const [d, setD] = useState({
    name: '', brand: '', packSize: '1', unit: 'kg', sell: '', cost: '', stock: '0', aliases: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (k: keyof typeof d) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setD({ ...d, [k]: e.target.value });

  const ready = d.name.trim().length > 0 && d.sell.trim() !== '';

  async function create() {
    setBusy(true); setErr(null);
    try {
      await post('/catalogue', {
        name: d.name.trim(),
        brand: d.brand.trim() || undefined,
        packSize: Number(d.packSize) || 1,
        unit: d.unit,
        sellPaise: toPaise(d.sell),
        costPaise: d.cost.trim() === '' ? undefined : toPaise(d.cost),
        stock: Number(d.stock) || 0,
        aliases: d.aliases.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean),
      });
      reload();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="pane mt-5 bg-[var(--panel)] p-5">
      <h2 className="display text-xl">New item</h2>
      <p className="muted mt-1 mb-4 text-[13px]">
        For the things no supplier bill covers.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <label className="inv-label">Item name</label>
          <input autoFocus value={d.name} onChange={set('name')} placeholder="Aashirvaad Atta 5kg" className="inv-field" />
        </div>
        <div>
          <label className="inv-label">Brand</label>
          <input value={d.brand} onChange={set('brand')} placeholder="Aashirvaad" className="inv-field" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="inv-label">Pack</label>
            <input type="number" step="any" min="0" value={d.packSize} onChange={set('packSize')} className="inv-field" />
          </div>
          <div>
            <label className="inv-label">Unit</label>
            <select value={d.unit} onChange={set('unit')} className="inv-field">
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="inv-label">Selling price (&#8377;)</label>
          <input type="number" step="any" min="0" value={d.sell} onChange={set('sell')} placeholder="285" className="inv-field" />
        </div>
        <div>
          <label className="inv-label">Cost price (&#8377;)</label>
          <input type="number" step="any" min="0" value={d.cost} onChange={set('cost')} placeholder="255" className="inv-field" />
        </div>
        <div>
          <label className="inv-label">Stock</label>
          <input type="number" step="any" min="0" value={d.stock} onChange={set('stock')} className="inv-field" />
        </div>
        <div className="sm:col-span-2 lg:col-span-1">
          <label className="inv-label">Names customers use</label>
          <input value={d.aliases} onChange={set('aliases')} placeholder="atta, aata, gehu ka atta" className="inv-field" />
        </div>
      </div>

      {err && <p className="mt-3 text-sm text-[var(--warn)]">{err}</p>}

      <div className="mt-4 flex items-center gap-2.5">
        <button
          onClick={create}
          disabled={!ready || busy}
          className="rounded-lg border-2 border-[var(--ink)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold shadow-[3px_3px_0_var(--ink)] disabled:opacity-40"
        >
          {busy ? 'Adding…' : 'Add to catalogue'}
        </button>
        <button onClick={onClose} className="muted px-2 text-sm hover:text-[var(--ink)]">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- the page */
const TABS = [
  { key: 'all' as const, label: 'All' },
  { key: 'low' as const, label: 'Low or out' },
  { key: 'unapproved' as const, label: 'Needs a name' },
  { key: 'hidden' as const, label: 'Hidden' },
];

export default function Catalogue() {
  const [skus, setSkus] = useState<Sku[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    get<{ skus: Sku[] }>('/catalogue')
      .then((d) => setSkus(d.skus))
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  const stats = useMemo(() => {
    const s = skus ?? [];
    return {
      total: s.length,
      out: s.filter((x) => x.stock === 0).length,
      low: s.filter((x) => x.stock > 0 && x.stock <= LOW_STOCK).length,
      pending: s.reduce((n, x) => n + x.suggested.length, 0),
      value: s.reduce((n, x) => n + x.sellPaise * x.stock, 0),
    };
  }, [skus]);

  const shown = useMemo(() => {
    let list = skus ?? [];
    if (tab === 'low') list = list.filter((s) => s.stock <= LOW_STOCK);
    if (tab === 'unapproved') list = list.filter((s) => s.suggested.length > 0);
    if (tab === 'hidden') list = list.filter((s) => !s.active);
    if (q.trim()) {
      const needle = q.toLowerCase();
      list = list.filter((s) =>
        `${s.name} ${s.brand ?? ''} ${s.aliases.map((a) => a.alias).join(' ')}`
          .toLowerCase()
          .includes(needle),
      );
    }
    return list;
  }, [skus, tab, q]);

  if (err) return <p className="text-[var(--warn)]">{err}</p>;
  if (!skus) return <RowsSkeleton rows={9} />;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="display text-[clamp(2rem,4vw,2.75rem)]">Inventory</h1>
          <p className="muted mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span>{stats.total} items</span>
            {stats.out > 0 && <span className="text-[var(--warn)]">{stats.out} out of stock</span>}
            {stats.low > 0 && <span>{stats.low} running low</span>}
            <span>&#8377;{rupees(stats.value)} on the shelf</span>
          </p>
        </div>

        <button
          onClick={() => setAdding((v) => !v)}
          className="rounded-lg border-2 border-[var(--ink)] bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold shadow-[4px_4px_0_var(--ink)] transition-transform hover:-translate-x-px hover:-translate-y-px"
        >
          {adding ? 'Close' : '+ Add item'}
        </button>
      </div>

      {adding && <AddRow onClose={() => setAdding(false)} reload={load} />}

      {stats.pending > 0 && tab !== 'unapproved' && (
        <button
          onClick={() => setTab('unapproved')}
          className="mt-5 flex w-full items-center gap-3 rounded-xl border-2 border-[var(--ink)] bg-[var(--amber)] px-4 py-3 text-left text-sm shadow-[3px_3px_0_var(--ink)]"
        >
          <b>{stats.pending} local names</b> are waiting to be accepted. Every one
          you accept is an order the shop understands first time.
          <span className="ml-auto shrink-0 font-semibold">Review &rarr;</span>
        </button>
      )}

      {/* controls */}
      <div className="mt-6 flex flex-wrap items-center gap-2.5">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} data-on={tab === t.key} className="inv-tab">
            {t.label}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or local name"
          className="inv-field ml-auto !w-auto min-w-[210px] flex-1 sm:flex-none"
        />
      </div>

      {/* the list */}
      {skus.length === 0 ? (
        <div className="pane mt-6 p-10 text-center">
          <h2 className="display text-2xl">Nothing in here yet</h2>
          <p className="muted mx-auto mt-3 max-w-md text-sm leading-relaxed">
            Typing four hundred items by hand is a two hour evening. Photograph
            a supplier bill instead and it takes five minutes.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/dashboard/bills"
              className="rounded-lg border-2 border-[var(--ink)] bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold shadow-[3px_3px_0_var(--ink)]"
            >
              Upload a bill
            </Link>
            <button onClick={() => setAdding(true)} className="rounded-lg border-2 border-[var(--ink)] px-5 py-2.5 text-sm font-semibold">
              Add one by hand
            </button>
          </div>
        </div>
      ) : (
        <div className="pane mt-4 p-2">
          {/* column headings, desktop only */}
          <div className="muted hidden grid-cols-[1fr_auto_auto_auto] gap-4 px-3 pt-2 pb-2 text-[11px] font-semibold sm:grid">
            <span>Item</span>
            <span className="w-20 text-right">Price</span>
            <span className="w-20 text-right">Stock</span>
            <span className="w-6" />
          </div>

          <div className="divide-y divide-[#1a1a1a12]">
            {shown.map((s) => {
              const isOpen = open === s.id;
              return (
                <div
                  key={s.id}
                  data-open={isOpen}
                  data-off={!s.active}
                  className="inv-row cursor-pointer px-3 py-3"
                  onClick={() => setOpen(isOpen ? null : s.id)}
                >
                  <div className="grid grid-cols-[1fr_auto] items-start gap-4 sm:grid-cols-[1fr_auto_auto_auto]">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {s.name}
                        {!s.active && <span className="muted ml-2 text-xs">hidden</span>}
                      </p>
                      <p className="muted mt-0.5 text-xs">
                        {[s.brand, `${s.packSize}${s.unit}`, s.costPaise ? `cost ₹${rupees(s.costPaise)}` : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                        <Aliases sku={s} reload={load} />
                      </div>
                    </div>

                    <div className="text-right sm:w-20">
                      <span className="text-sm tabular-nums">&#8377;{rupees(s.sellPaise)}</span>
                    </div>

                    <div className="hidden sm:block sm:w-20 sm:text-right">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs tabular-nums ${
                          s.stock === 0 ? 'stock-out' : s.stock <= LOW_STOCK ? 'stock-low' : ''
                        }`}
                      >
                        {s.stock === 0 ? 'out' : s.stock}
                      </span>
                    </div>

                    <span className={`muted hidden w-6 text-center text-lg transition-transform sm:block ${isOpen ? 'rotate-45' : ''}`}>
                      +
                    </span>
                  </div>

                  {isOpen && <Editor sku={s} onDone={() => setOpen(null)} reload={load} />}
                </div>
              );
            })}
          </div>

          {shown.length === 0 && (
            <p className="muted px-3 py-10 text-center text-sm">
              Nothing matches that.
            </p>
          )}
        </div>
      )}
    </>
  );
}
