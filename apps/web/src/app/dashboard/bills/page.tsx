'use client';

import { useState } from 'react';
import { API } from '@/lib/api';

/**
 * THE HERO SCREEN of module 1.
 *
 * Typing 400 SKUs at ~20 seconds each is over two hours. Uploading six
 * supplier bills is five minutes. That difference is the entire reason
 * this product gets adopted rather than abandoned at setup.
 *
 * The bill also carries cost price, so margin is computable, and its date
 * sequence is the shop's own restock cadence.
 */
interface ParsedLine {
  name: string;
  qty: number;
  ratePaise: number;
  amountPaise: number;
}

export default function Bills() {
  const [file, setFile] = useState<File | null>(null);
  const [lines, setLines] = useState<ParsedLine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // multipart, so no JSON helper here, but the session cookie still
      // has to ride along or the route 401s.
      const res = await fetch(`${API}/bills/parse`, {
        method: 'POST', body: fd, credentials: 'include',
      });
      if (!res.ok) throw new Error(`parse failed (${res.status})`);
      const j = (await res.json()) as { bill: { items: ParsedLine[] } };
      setLines(j.bill.items);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-semibold">Bill upload</h1>
      <p className="muted mt-1 text-sm">
        Supplier ka bill daaliye. Items, quantity aur rate apne aap bhar jayenge.
      </p>

      <div className="panel mt-6 p-6">
        <input
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm"
        />
        <button
          onClick={upload}
          disabled={!file || busy}
          className="ml-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
        >
          {busy ? 'Padha ja raha hai...' : 'Bill padho'}
        </button>
        {err && <p className="mt-3 text-sm text-[var(--warn)]">{err}</p>}
      </div>

      {lines && (
        <>
          <h2 className="mt-8 text-lg font-medium">
            Review, {lines.length} items mile
          </h2>
          <p className="muted mt-1 text-sm">
            Galat ho to yahin theek kar dijiye. Commit karne par catalogue aur
            stock dono update honge.
          </p>

          <div className="panel mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="muted border-b border-[var(--line)] text-left">
                <tr>
                  <th className="p-3 font-normal">Item</th>
                  <th className="p-3 font-normal">Qty</th>
                  <th className="p-3 font-normal">Rate</th>
                  <th className="p-3 font-normal">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-b border-[var(--line)] last:border-0">
                    <td className="p-3">{l.name}</td>
                    <td className="p-3">{l.qty}</td>
                    <td className="p-3">Rs {(l.ratePaise / 100).toFixed(2)}</td>
                    <td className="p-3">Rs {(l.amountPaise / 100).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
