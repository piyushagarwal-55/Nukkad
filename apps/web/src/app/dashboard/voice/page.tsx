'use client';

import { useCallback, useRef, useState } from 'react';
import { API } from '@/lib/api';

/**
 * The voice agent, without a phone.
 *
 * Hold the button, talk, let go. The audio goes to /voice/turn, which
 * runs the SAME function a real call will -- transcribe, decide,
 * resolve, reply, speak. Only telephony is missing, and telephony is the
 * only part that costs money.
 *
 * The trace is on screen on purpose. What the ear HEARD is where nearly
 * every voice bug is visible, and it is the one thing a handset cannot
 * show you: on a phone you only hear the answer and have to guess why it
 * was wrong. Here you can read the transcript, the action, the basket
 * and the timing side by side, and copy the lot into a message.
 */

interface Trace {
  heard: string;
  heardRaw: string;
  asrEngine: string;
  asrMs: number;
  reply: string;
  spoken: string;
  action: string;
  goal: string;
  ttsMs: number;
  totalMs: number;
  basket: string[];
  lastNamed: string[];
  audioBase64: string | null;
}

type Phase = 'idle' | 'listening' | 'thinking';

export default function Voice() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [turns, setTurns] = useState<Trace[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const start = useCallback(async () => {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // the shop's line is a phone line: mono, and let the browser do
        // the noise work rather than sending a kitchen to the ASR
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const mr = new MediaRecorder(stream);
      chunks.current = [];
      mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);

      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: mr.mimeType || 'audio/webm' });
        if (blob.size < 2000) {
          setPhase('idle');
          setErr('Too short -- hold the button while you speak.');
          return;
        }

        setPhase('thinking');
        try {
          const res = await fetch(`${API}/voice/turn`, {
            method: 'POST',
            headers: { 'Content-Type': blob.type },
            body: blob,
          });
          if (!res.ok) throw new Error(`server said ${res.status}`);

          const trace = (await res.json()) as Trace;
          setTurns((t) => [...t, trace]);

          if (trace.audioBase64) {
            const audio = new Audio(`data:audio/wav;base64,${trace.audioBase64}`);
            void audio.play().catch(() => undefined);
          }
        } catch (e) {
          setErr((e as Error).message);
        } finally {
          setPhase('idle');
        }
      };

      mr.start();
      rec.current = mr;
      setPhase('listening');
    } catch {
      setErr('No microphone. Allow access and try again.');
    }
  }, []);

  const stop = useCallback(() => {
    rec.current?.state === 'recording' && rec.current.stop();
  }, []);

  const reset = useCallback(async () => {
    await fetch(`${API}/voice/reset`, { method: 'POST' });
    setTurns([]);
    setErr(null);
  }, []);

  /** everything on screen, as one block to paste into a message */
  const copyLog = useCallback(() => {
    const text = turns
      .map((t, i) =>
        [
          `--- turn ${i + 1} ---`,
          `HEARD   "${t.heard}"   [${t.asrEngine}, ${t.asrMs}ms]`,
          t.heardRaw && t.heardRaw !== t.heard ? `RAW     ${t.heardRaw}` : '',
          `ACTION  ${t.action} / ${t.goal}`,
          `SAID    ${t.reply}`,
          `BASKET  ${t.basket.join(', ') || '(empty)'}`,
          `"YEH"   ${t.lastNamed.join(', ') || '(nothing)'}`,
          `TIMING  ear ${t.asrMs}ms + think ${t.totalMs - t.asrMs - t.ttsMs}ms + mouth ${t.ttsMs}ms = ${t.totalMs}ms`,
        ].filter(Boolean).join('\n'),
      )
      .join('\n\n');
    void navigator.clipboard?.writeText(text);
  }, [turns]);

  return (
    <>
      <h1 className="display text-[clamp(2rem,4vw,2.75rem)]">Voice</h1>
      <p className="muted mt-2 max-w-xl text-sm leading-relaxed">
        The same agent your customers reach on WhatsApp, listening through
        this browser instead of a phone line. Nothing here costs a call.
      </p>

      <section className="pane card-in mt-7 p-6">
        <div className="flex flex-wrap items-center gap-4">
          <button
            onMouseDown={start}
            onMouseUp={stop}
            onMouseLeave={stop}
            onTouchStart={(e) => { e.preventDefault(); void start(); }}
            onTouchEnd={(e) => { e.preventDefault(); stop(); }}
            disabled={phase === 'thinking'}
            className={`grid h-24 w-24 shrink-0 place-items-center rounded-full border-2 border-[var(--ink)] text-sm font-semibold transition-transform select-none ${
              phase === 'listening'
                ? 'scale-110 bg-[var(--hot)] text-[var(--bg)]'
                : phase === 'thinking'
                  ? 'bg-[var(--amber)]'
                  : 'bg-[var(--accent)]'
            }`}
            style={{ boxShadow: '4px 4px 0 var(--ink)' }}
          >
            {phase === 'listening' ? 'sun raha…' : phase === 'thinking' ? 'soch raha…' : 'Hold'}
          </button>

          <div className="min-w-[200px] flex-1">
            <p className="text-sm leading-relaxed">
              Hold and speak in Hinglish, the way a customer would.
              <br />
              <span className="muted">
                &ldquo;do kilo atta bhej dena&rdquo; &middot; &ldquo;moong dal ka price
                kya hai&rdquo; &middot; &ldquo;haan daal do&rdquo;
              </span>
            </p>
            <div className="mt-3 flex flex-wrap gap-2.5">
              <button
                onClick={reset}
                className="rounded-lg border-2 border-[var(--ink)] px-3.5 py-2 text-xs font-semibold"
              >
                New conversation
              </button>
              {turns.length > 0 && (
                <button
                  onClick={copyLog}
                  className="rounded-lg border-2 border-[var(--ink)] bg-[var(--accent)] px-3.5 py-2 text-xs font-semibold shadow-[3px_3px_0_var(--ink)]"
                >
                  Copy the whole log
                </button>
              )}
            </div>
          </div>
        </div>

        {err && <p className="mt-4 text-sm text-[var(--warn)]">{err}</p>}
      </section>

      {turns.map((t, i) => (
        <section key={i} className="pane card-in mt-5 p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="muted text-xs">turn {i + 1}</span>
            <span className="muted text-xs tabular-nums">
              ear {t.asrMs}ms &middot; think {t.totalMs - t.asrMs - t.ttsMs}ms &middot; mouth{' '}
              {t.ttsMs}ms &middot; <b className="text-[var(--ink)]">{t.totalMs}ms</b>
            </span>
          </div>

          <p className="mt-4 text-xs font-semibold tracking-wide uppercase opacity-60">
            Heard &middot; {t.asrEngine}
          </p>
          <p className="mt-1 text-lg">&ldquo;{t.heard}&rdquo;</p>
          {t.heardRaw && t.heardRaw !== t.heard && (
            <p className="muted mt-1 text-sm">raw: {t.heardRaw}</p>
          )}

          <p className="mt-4 text-xs font-semibold tracking-wide uppercase opacity-60">
            Said &middot; {t.action} / {t.goal}
          </p>
          <p className="mt-1 text-lg whitespace-pre-wrap">{t.reply}</p>

          <div className="muted mt-4 flex flex-wrap gap-x-6 gap-y-1 border-t border-[#1a1a1a12] pt-3 text-xs">
            <span>basket: {t.basket.join(', ') || 'empty'}</span>
            <span>&ldquo;yeh&rdquo; means: {t.lastNamed.join(', ') || 'nothing yet'}</span>
          </div>
        </section>
      ))}
    </>
  );
}
