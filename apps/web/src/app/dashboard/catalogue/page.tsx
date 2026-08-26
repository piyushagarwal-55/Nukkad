'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { get, patch, post, rupees } from '@/lib/api';
import { RowsSkeleton } from '@/components/Loading';

/**
 * The CORRECTION surface, not the entry surface. Nobody types 400 SKUs here.
 * They arrive from bill upload; this screen fixes what the parser got wrong
 * and approves the subnames customers actually use.
 */
interface Alias { id: string; alias: string }
interface Sku {
  id: string; name: string; brand: string | null;
  sellPaise: number; costPaise: number | null; stock: number; active: boolean;
  aliases: Alias[]; suggested: Alias[];
}

export default function Catalogue() {
  const [skus, setSkus] = useState<Sku[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(() => {
    get<{ skus: Sku[] }>('/catalogue').then((d) => setSkus(d.skus)).catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  async function save(id: string, body: Record<string, number>) {
    await patch(`/catalogue/${id}`, body);
    load();
  }

  if (err) return <p className="text-[var(--warn)]">{err}</p>;
  if (!skus) return <RowsSkeleton rows={9} />;

  if (!skus.length) {
    return (
      <div className="panel p-10 text-center">
        <h1 className="text-xl font-semibold">Catalogue khali hai</h1>
        <p className="muted mx-auto mt-3 max-w-md text-sm leading-relaxed">
          400 items haath se likhne mein do ghante lagte hain. Supplier ka
          bill daaliye, paanch minute mein ho jayega.
        </p>
        <Link href="/dashboard/bills"
          className="mt-6 inline-block rounded-lg bg-[var(--accent)] px-5 py-2.5 font-medium text-black">
          Bill upload karein
        </Link>
      </div>
    );
  }

  const shown = q
    ? skus.filter((s) =>
        (s.name + ' ' + s.aliases.map((a) => a.alias).join(' ')).toLowerCase().includes(q.toLowerCase()))
    : skus;

  const pending = skus.reduce((n, s) => n + s.suggested.length, 0);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Catalogue</h1>
          <p className="muted mt-1 text-sm">
            {skus.length} items. Subnames wo naam hain jinse customer maangta hai.
          </p>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search"
          className="panel px-3 py-2 text-sm outline-none" />
      </div>

      {pending > 0 && (
        <div className="panel mt-5 border-[var(--accent)] p-4 text-sm">
          <b>{pending} subnames</b> suggest kiye gaye hain. Neeche tap karke approve kijiye.
          Jitne zyada approve, utna behtar order samajh mein aayega.
        </div>
      )}

      <div className="panel mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="muted border-b border-[var(--line)] text-left">
            <tr>
              <th className="p-3 font-normal">Item</th>
              <th className="p-3 font-normal">Subnames</th>
              <th className="p-3 font-normal">Price</th>
              <th className="p-3 font-normal">Stock</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id} className="border-b border-[var(--line)] align-top last:border-0">
                <td className="p-3">
                  {s.name}
                  {s.costPaise ? (
                    <span className="muted block text-xs">cost Rs {rupees(s.costPaise)}</span>
                  ) : null}
                </td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-1.5">
                    {s.aliases.map((a) => (
                      <span key={a.id}
                        className="rounded border border-[var(--line)] px-2 py-0.5 text-xs">
                        {a.alias}
                      </span>
                    ))}
                    {s.suggested.map((a) => (
                      <button key={a.id}
                        onClick={async () => { await post(`/aliases/${a.id}/approve`); load(); }}
                        title="Approve karein"
                        className="rounded border border-dashed border-[var(--accent)] px-2 py-0.5 text-xs text-[var(--accent)]">
                        + {a.alias}
                      </button>
                    ))}
                  </div>
                </td>
                <td className="p-3">
                  <input defaultValue={s.sellPaise / 100} type="number"
                    onBlur={(e) => {
                      const v = Math.round(Number(e.target.value) * 100);
                      if (v !== s.sellPaise && v >= 0) void save(s.id, { sellPaise: v });
                    }}
                    className="w-20 bg-transparent outline-none" />
                </td>
                <td className="p-3">
                  <input defaultValue={s.stock} type="number"
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== s.stock && v >= 0) void save(s.id, { stock: v });
                    }}
                    className={'w-16 bg-transparent outline-none ' + (s.stock === 0 ? 'text-[var(--warn)]' : '')} />
                  {s.stock === 0 && <span className="ml-1 text-xs text-[var(--warn)]">khatam</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
