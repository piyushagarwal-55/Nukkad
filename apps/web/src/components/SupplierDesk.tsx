'use client';

import { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '@/lib/api';

/**
 * THE SUPPLIER LEG, ON SCREEN.
 *
 * The dashboard is the proof surface, not somebody's phone: it shows the
 * exact words that went to the distributor, the arithmetic behind every
 * quantity, and the reply when it comes back. A screenshot of a WhatsApp
 * chat proves a message exists; this proves the shop decided to send it.
 *
 * Nothing sends without the owner reading the literal text first -- an
 * ordering message is a commitment to buy.
 */

interface Supplier { id: string; name: string; phone: string }
interface Line { skuId: string; name: string; inStock: number; quantity: number; why: string }
interface Suggestion { lowStockAt: number; lines: Line[]; supplier: Supplier | null; preview: string | null }
interface Msg {
  id: string; supplier: string; phone: string;
  direction: 'IN' | 'OUT'; body: string; createdAt: string;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

export function SupplierDesk() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [ready, setReady] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [sug, setSug] = useState<Suggestion | null>(null);
  const [thread, setThread] = useState<Msg[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, t] = await Promise.all([
      get<{ suppliers: Supplier[]; transportReady: boolean }>('/suppliers'),
      get<{ messages: Msg[] }>('/suppliers/thread'),
    ]);
    setSuppliers(s.suppliers);
    setReady(s.transportReady);
    setThread(t.messages);
    setPicked((p) => p ?? s.suppliers[0]?.id ?? null);
  }, []);

  useEffect(() => { load().catch(() => {}); }, [load]);

  useEffect(() => {
    const q = picked ? `?supplierId=${picked}` : '';
    get<Suggestion>(`/suppliers/suggest${q}`).then(setSug).catch(() => setSug(null));
  }, [picked, suppliers.length]);

  const add = async () => {
    if (!name.trim() || !phone.trim()) return;
    setBusy(true);
    try {
      await post('/suppliers', { name, phone });
      setName(''); setPhone('');
      await load();
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  };

  const send = async () => {
    if (!picked) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await post<{ ok: boolean; supplier: string; error?: string }>(
        '/suppliers/order', { supplierId: picked },
      );
      setNote(r.ok
        ? `Order ${r.supplier} ko WhatsApp par bhej diya.`
        : `Bheja nahi ja saka: ${r.error ?? 'unknown'}`);
      await load();
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <section className="pane card-in mt-6 p-6">
      <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
        Supplier · automatic order
      </h2>
      <p className="muted mt-1 text-sm">
        Jo khatam ho raha hai, uska order distributor ko khud chala jata hai.
        Bhejne se pehle poora message yahan dikhta hai.
      </p>

      {!ready && (
        <p className="mt-3 rounded-lg bg-[#B9811520] p-3 text-sm">
          WhatsApp transport abhi configured nahi hai — message ban jayega par
          jayega nahi.
        </p>
      )}

      {/* who we order from */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {suppliers.map((s) => (
          <button
            key={s.id}
            onClick={() => setPicked(s.id)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              picked === s.id
                ? 'bg-[var(--accent)] font-semibold text-white'
                : 'border border-[var(--line)]'
            }`}
          >
            {s.name} <span className="opacity-60">· {s.phone}</span>
          </button>
        ))}
        {suppliers.length > 0 && picked && (
          <button
            onClick={async () => { await del(`/suppliers/${picked}`); setPicked(null); load(); }}
            className="muted text-xs underline"
          >
            hatao
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Distributor ka naam"
          className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
        />
        <input
          value={phone} onChange={(e) => setPhone(e.target.value)}
          placeholder="WhatsApp number"
          className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm"
        />
        <button
          onClick={add} disabled={busy}
          className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
        >
          Add supplier
        </button>
      </div>

      {/* what would be ordered, and why */}
      {sug && sug.lines.length > 0 && (
        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide opacity-60">
              Order banaya gaya · {sug.lines.length} item
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {sug.lines.map((l) => (
                <div key={l.skuId} className="border-b border-[#1a1a1a12] pb-2">
                  <p className="text-sm font-semibold">
                    {l.name} — <span className="tabular-nums">{l.quantity}</span> packet
                  </p>
                  <p className="muted text-xs">
                    shelf par {l.inStock} · {l.why}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide opacity-60">
              Jo message jayega
            </p>
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-xl bg-[#fafafb] p-4 text-sm leading-relaxed">
              {sug.preview ?? 'Pehle ek supplier add kijiye.'}
            </pre>
            <button
              onClick={send}
              disabled={busy || !picked || !sug.preview}
              className="mt-3 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Bhej rahe hain…' : 'Send order on WhatsApp'}
            </button>
            {note && <p className="muted mt-2 text-sm">{note}</p>}
          </div>
        </div>
      )}

      {sug && sug.lines.length === 0 && (
        <p className="muted mt-5 text-sm">
          Abhi kuch bhi {sug.lowStockAt} se neeche nahi — order karne ki zarurat nahi.
        </p>
      )}

      {/* the thread */}
      {thread.length > 0 && (
        <div className="mt-7">
          <p className="text-xs font-semibold uppercase tracking-wide opacity-60">
            Supplier thread
          </p>
          <div className="mt-3 flex flex-col gap-2.5">
            {thread.map((m) => (
              <div
                key={m.id}
                className={`rounded-xl p-3 text-sm ${
                  m.direction === 'OUT'
                    ? 'bg-[#4f46e510] border-l-2 border-l-[var(--accent)]'
                    : 'bg-[#fafafb]'
                }`}
              >
                <p className="muted text-xs">
                  {m.direction === 'OUT' ? `shop → ${m.supplier}` : `${m.supplier} → shop`}
                  {' · '}{when(m.createdAt)}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
