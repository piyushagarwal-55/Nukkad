'use client';

import { useEffect, useRef, useState } from 'react';
import { API } from '@/lib/api';

/**
 * THE JUDGE-FACING SURFACE.
 *
 * Posts to /wa/sim, which runs the IDENTICAL pipeline as /wa/twilio. Same
 * ranker, same stock check, same ledger. Only the transport differs.
 *
 * This exists because making judges text a US sandbox number is friction
 * you do not control, and because venue wifi dies at every hackathon.
 */
interface Bubble { from: 'me' | 'bot'; text: string }

const HOUSEHOLD = process.env.NEXT_PUBLIC_DEMO_HOUSEHOLD ?? '+918979560165';
const SHOP = process.env.NEXT_PUBLIC_DEMO_KIRANA ?? '+919927306131';

export default function Sim() {
  const [msgs, setMsgs] = useState<Bubble[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  async function send(payload: { text?: string; mediaBase64?: string; mediaMime?: string }, label: string) {
    setMsgs((m) => [...m, { from: 'me', text: label }]);
    setBusy(true);
    try {
      const res = await fetch(`${API}/wa/sim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ senderId: HOUSEHOLD, recipientId: SHOP, ...payload }),
      });
      const j = (await res.json()) as { replies?: Array<{ text: string; quickReplies?: Array<{ id: string; label: string }> }> };
      for (const r of j.replies ?? []) {
        const opts = r.quickReplies?.map((q) => `${q.id} = ${q.label}`).join('\n');
        setMsgs((m) => [...m, { from: 'bot', text: opts ? `${r.text}\n\n${opts}` : r.text }]);
      }
    } catch (e) {
      setMsgs((m) => [...m, { from: 'bot', text: `[error] ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function toggleRecord() {
    if (recording) { recRef.current?.stop(); setRecording(false); return; }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Browser gives webm/opus, WhatsApp gives ogg/opus. The adapter
    // normalises both, so the pipeline never sees the difference.
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const b64 = await new Promise<string>((resolve) => {
        const fr = new FileReader();
        fr.onloadend = () => resolve(fr.result as string);
        fr.readAsDataURL(blob);
      });
      void send({ mediaBase64: b64, mediaMime: 'audio/webm' }, '[voice note]');
    };
    rec.start();
    recRef.current = rec;
    setRecording(true);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-4 py-6">
      <div className="flex items-center justify-between border-b border-[var(--line)] pb-3">
        <div>
          <p className="font-medium">Sunita Kirana Store</p>
          <p className="muted text-xs">same webhook, same ranker, same ledger</p>
        </div>
        <span className="muted text-xs">{HOUSEHOLD.slice(-4)}</span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto py-5">
        {msgs.length === 0 && (
          <p className="muted text-sm">
            Try: <em>bhaiya do kilo atta aur ek litre tel bhej dena</em>
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.from === 'me' ? 'flex justify-end' : 'flex justify-start'}>
            <pre
              className={
                'max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm font-sans ' +
                (m.from === 'me'
                  ? 'bg-[var(--accent)] text-black'
                  : 'panel')
              }
            >
              {m.text}
            </pre>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="flex gap-2 border-t border-[var(--line)] pt-3">
        <button
          onClick={toggleRecord}
          className={
            'rounded-lg px-3 py-2 text-sm ' +
            (recording ? 'bg-[var(--warn)] text-black' : 'panel')
          }
        >
          {recording ? 'Stop' : 'Bolo'}
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim() && !busy) {
              void send({ text }, text);
              setText('');
            }
          }}
          placeholder="Message likhiye"
          className="panel flex-1 px-3 py-2 text-sm outline-none"
        />
        <button
          onClick={() => { if (text.trim()) { void send({ text }, text); setText(''); } }}
          disabled={busy || !text.trim()}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
        >
          {busy ? '...' : 'Bhejo'}
        </button>
      </div>
    </main>
  );
}
