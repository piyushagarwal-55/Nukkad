'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** filled in when the stream finishes: how long until the first sound */
  firstSoundMs?: number;
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
          if (!res.ok || !res.body) throw new Error(`server said ${res.status}`);

          /**
           * SENTENCES ARRIVE ONE AT A TIME and are played in order.
           *
           * The point of cutting the reply into sentences on the server
           * is that the first one can be heard while the rest is still
           * being made. Waiting for the whole stream before playing any
           * of it would give all of that back.
           */
          const queue: string[] = [];
          let playing = false;

          const drain = async () => {
            if (playing) return;
            playing = true;
            while (queue.length) {
              const b64 = queue.shift()!;
              const el = new Audio(`data:audio/wav;base64,${b64}`);
              await new Promise<void>((done) => {
                el.onended = () => done();
                el.onerror = () => done();
                void el.play().catch(() => done());
              });
            }
            playing = false;
          };

          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';

          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });

            // SSE frames are separated by a blank line
            const parts = buf.split('\n\n');
            buf = parts.pop() ?? '';

            for (const part of parts) {
              const line = part.replace(/^data: /, '').trim();
              if (!line) continue;
              const ev = JSON.parse(line) as
                | ({ type: 'trace' } & Trace)
                | { type: 'audio'; b64: string }
                | { type: 'done'; firstMs: number; totalMs: number }
                | { type: 'error'; message: string };

              if (ev.type === 'trace') {
                setTurns((t) => [...t, ev]);
                setPhase('idle');
              } else if (ev.type === 'audio') {
                queue.push(ev.b64);
                void drain();
              } else if (ev.type === 'done') {
                setTurns((t) =>
                  t.map((x, i) => (i === t.length - 1 ? { ...x, firstSoundMs: ev.firstMs } : x)),
                );
              } else if (ev.type === 'error') {
                setErr(ev.message);
              }
            }
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

  /**
   * WARM THE WHOLE PIPELINE WHILE THEY ARE STILL READING THE PAGE.
   *
   * The first turn of a session measured 13052ms to first sound against
   * 3526ms for the second, and nothing about it was harder -- it was
   * paying for a cold database connection, three cold caches and a cold
   * Groq connection. All of that is knowable before anyone speaks.
   *
   * Fire and forget: if it fails the first turn is merely as slow as it
   * used to be, which is not worth an error message on a page whose job
   * is to look ready.
   */
  useEffect(() => {
    void fetch(`${API}/voice/warm`, { method: 'POST' }).catch(() => {});
  }, []);

  /**
   * WARM THE PIPELINE WHILE THEY ARE STILL READING THE PAGE.
   *
   * The first turn of a real call measured 13052ms to first sound against
   * 3526ms for the second, and nothing about it was harder -- it was
   * paying for a cold database connection, three cold caches and a cold
   * Groq connection. All of that is knowable before anyone speaks.
   *
   * Fire and forget. If it fails the first turn is merely as slow as it
   * used to be, which is not worth an error message on a page whose job
   * is to look ready. The server deduplicates, so React mounting this
   * twice in development costs one warm-up.
   */
  useEffect(() => {
    void fetch(`${API}/voice/warm`, { method: 'POST' }).catch(() => {});
  }, []);

  /**
   * HOLD SPACE TO TALK.
   *
   * The same gesture the interview agent in practers uses, and for the
   * same reason: a hand on the mouse is a hand not gesturing at the
   * screen, and while testing you want to talk, read the trace, and talk
   * again without ever leaving the keyboard.
   *
   * Three things this has to get right, all of them learned by getting
   * them wrong first:
   *
   * `repeat` -- holding a key fires keydown over and over, which would
   * start a new recording on every repeat and leave a pile of orphaned
   * MediaRecorders.
   *
   * `code` rather than `key` -- the space bar's key is a literal " ",
   * which is easy to mistype and impossible to read.
   *
   * The focus check -- space ACTIVATES a focused button in every browser,
   * so pressing it after clicking "New conversation" would fire that
   * button again rather than record. Typing in a field must be left
   * alone for the same reason.
   */
  useEffect(() => {
    const typing = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      return !!t && (/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(t.tagName) || t.isContentEditable);
    };

    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || typing(e.target)) return;
      e.preventDefault(); // otherwise the page scrolls under you
      if (phase === 'idle') void start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e.target)) return;
      e.preventDefault();
      stop();
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [phase, start, stop]);

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
          `TIMING  ear ${t.asrMs}ms + think ${t.totalMs - t.asrMs}ms + first sound ${t.firstSoundMs ?? '?'}ms`,
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
            /**
             * Blurred on release, or the space bar stops working the
             * moment you use the mouse once: a focused button swallows
             * space to activate itself, and the guard above would read
             * that as "typing" and ignore the key.
             */
            onMouseUp={(e) => { stop(); e.currentTarget.blur(); }}
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
              Hold <kbd className="rounded border border-[var(--ink)] px-1.5 py-0.5 text-xs font-semibold">space</kbd>{' '}
              (or this button) and speak in Hinglish, the way a customer would.
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
              ear {t.asrMs}ms &middot; think {t.totalMs - t.asrMs}ms
              {t.firstSoundMs ? (
                <>
                  {' '}&middot; first sound{' '}
                  <b className="text-[var(--ink)]">+{t.firstSoundMs}ms</b>
                </>
              ) : null}
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
