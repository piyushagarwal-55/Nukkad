'use client';

import { Fragment, useEffect, useState } from 'react';
import { get, rupees } from '@/lib/api';

interface Line {
  name: string; quantity: number; linePaise: number;
  method: string; confidence: number; wasSubstituted: boolean; sourceText: string;
}
interface Order {
  id: string; household: string; status: string; source: string;
  totalPaise: number; createdAt: string; transcript: string | null;
  latencyMs: number | null; lines: Line[]; outstandingPaise: number;
}

/**
 * Flat list, no dashboard chrome. The one non-obvious column is `method`:
 * it records HOW each line was matched, which is both useful to the owner
 * and the place the ablation numbers come from.
 */
export default function Orders() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    get<{ orders: Order[] }>('/orders').then((d) => setOrders(d.orders)).catch((e) => setErr(e.message));
  }, []);

  if (err) return <p className="text-[var(--warn)]">{err}</p>;
  if (!orders) return <p className="muted text-sm">Loading...</p>;

  return (
    <>
      <h1 className="text-2xl font-semibold">Orders</h1>
      <p className="muted mt-1 text-sm">{orders.length} orders. Kisi par tap karke detail dekhiye.</p>

      <div className="panel mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="muted border-b border-[var(--line)] text-left">
            <tr>
              <th className="p-3 font-normal">Ghar</th>
              <th className="p-3 font-normal">Items</th>
              <th className="p-3 font-normal">Total</th>
              <th className="p-3 font-normal">Baaki</th>
              <th className="p-3 font-normal">Kaise</th>
              <th className="p-3 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <Fragment key={o.id}>
                <tr
                  onClick={() => setOpen(open === o.id ? null : o.id)}
                  className="cursor-pointer border-b border-[var(--line)] last:border-0 hover:bg-black/[0.04]">
                  <td className="p-3">{o.household}</td>
                  <td className="p-3">{o.lines.length}</td>
                  <td className="p-3">Rs {rupees(o.totalPaise)}</td>
                  <td className={'p-3 ' + (o.outstandingPaise > 0 ? 'text-[var(--warn)]' : 'muted')}>
                    {o.outstandingPaise > 0 ? `Rs ${rupees(o.outstandingPaise)}` : '-'}
                  </td>
                  <td className="muted p-3 text-xs">{o.source}</td>
                  <td className="p-3 text-xs">{o.status}</td>
                </tr>
                {open === o.id && (
                  <tr className="border-b border-[var(--line)]">
                    <td colSpan={6} className="bg-[var(--sand)]/60 p-4">
                      {o.transcript && (
                        <p className="muted mb-3 text-xs">
                          Transcript: <span className="text-[var(--ink)]">{o.transcript}</span>
                          {o.latencyMs ? ` (${o.latencyMs}ms)` : ''}
                        </p>
                      )}
                      <table className="w-full text-xs">
                        <tbody>
                          {o.lines.map((l, i) => (
                            <tr key={i}>
                              <td className="py-1 pr-4">{l.quantity} x {l.name}</td>
                              <td className="muted py-1 pr-4">said &quot;{l.sourceText}&quot;</td>
                              <td className="py-1 pr-4">
                                <span className="rounded border border-[var(--line)] px-1.5 py-0.5">
                                  {l.method}
                                </span>
                                {l.wasSubstituted && (
                                  <span className="ml-1 text-[var(--warn)]">badla gaya</span>
                                )}
                              </td>
                              <td className="muted py-1">conf {l.confidence.toFixed(2)}</td>
                              <td className="py-1 text-right">Rs {rupees(l.linePaise)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
