'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '@/lib/api';

/**
 * The voice agent, without a phone.
 *
 * Two sockets stay open for as long as this page does: one to our API,
 * and one from there to Sarvam's realtime recogniser. Audio goes up as it
 * is spoken and words come back while the customer is still talking, so
 * by the time they stop, the transcript is already here.
 *
 * WHY THERE IS NO BUTTON TO HOLD ANY MORE. There used to be, because the
 * batch recogniser needed to be handed a complete clip and something had
 * to decide when the clip ended. Sarvam's own VAD decides that now, which
 * is both how a phone call works and how a person does: you stop talking
 * and the other end answers. The first turn of the old version spent
 * 4603ms in `ear` alone, paying for a TLS handshake and a cold model on
 * every session. That cost is gone, not reduced.
 *
 * The trace is still on screen on purpose. What the ear HEARD is where
 * nearly every voice bug is visible, and it is the one thing a handset
 * cannot show you: on a phone you hear the answer and guess why it was
 * wrong. Here you can read the partials arriving, the final, the action
 * and the timing side by side, and copy the lot into a message.
 */

interface Trace {
  heard: string;
  reply: string;
  action: string;
  goal: string;
  firstSoundMs: number;
  totalMs: number;
}

type Phase = 'connecting' | 'ready' | 'listening' | 'thinking' | 'error';

export default function Voice() {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [partial, setPartial] = useState('');
  const [turns, setTurns] = useState<Trace[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const ws = useRef<WebSocket | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const mutedRef = useRef(false);

  /**
   * SENTENCES ARRIVE ONE AT A TIME AND ARE PLAYED IN ORDER.
   *
   * The point of cutting a reply into sentences on the server is that the
   * first can be heard while the rest is still being made. Waiting for
   * the whole stream before playing any of it would give all of that
   * back, and playing them as they arrive without a queue would have the
   * shop talking over itself.
   */
  const queue = useRef<string[]>([]);
  const playing = useRef(false);

  const drain = useCallback(async () => {
    if (playing.current) return;
    playing.current = true;
    while (queue.current.length) {
      const b64 = queue.current.shift()!;
      const el = new Audio(`data:audio/wav;base64,${b64}`);
      await new Promise<void>((done) => {
        el.onended = () => done();
        el.onerror = () => done();
        void el.play().catch(() => done());
      });
    }
    playing.current = false;
  }, []);

  useEffect(() => {
    let closed = false;

    const start = async () => {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({
          // a shop's line is a phone line: mono, and let the browser do the
          // noise work rather than sending a kitchen to the recogniser
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        if (closed) {
          mic.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = mic;

        /**
         * 16kHz asked for HERE rather than resampled by hand. The browser's
         * own graph does it properly, and Sarvam takes 8000 or 16000 and
         * closes the socket on anything else.
         */
        const ctx = new AudioContext({ sampleRate: 16000 });
        audio.current = ctx;
        await ctx.audioWorklet.addModule('/pcm-worklet.js');

        const socket = new WebSocket(`${API.replace(/^http/, 'ws')}/voice/stream`);
        socket.binaryType = 'arraybuffer';
        ws.current = socket;

        socket.onopen = () => setPhase('ready');
        socket.onclose = () => !closed && setPhase('error');
        socket.onerror = () => !closed && setErr('Connection lost. Reload to try again.');

        socket.onmessage = (e) => {
          const ev = JSON.parse(e.data as string) as
            | { type: 'partial'; text: string }
            | { type: 'listening' }
            | { type: 'thinking' }
            | { type: 'audio'; b64: string }
            | ({ type: 'turn' } & Trace)
            | { type: 'error'; message: string }
            | { type: 'ear-closed' };

          if (ev.type === 'partial') {
            setPartial(ev.text);
            setPhase('listening');
          } else if (ev.type === 'listening') {
            // barge-in: they started talking, so stop the shop mid-sentence
            queue.current = [];
            setPhase('listening');
          } else if (ev.type === 'thinking') {
            setPhase('thinking');
          } else if (ev.type === 'audio') {
            queue.current.push(ev.b64);
            void drain();
          } else if (ev.type === 'turn') {
            setTurns((t) => [...t, ev]);
            setPartial('');
            setPhase('ready');
          } else if (ev.type === 'error') {
            setErr(ev.message);
          } else if (ev.type === 'ear-closed') {
            setErr('The recogniser closed the session. Reload to reconnect.');
          }
        };

        const node = new AudioWorkletNode(ctx, 'pcm-worklet');
        node.port.onmessage = (e) => {
          if (mutedRef.current) return;
          if (socket.readyState === WebSocket.OPEN) socket.send(e.data as Int16Array);
        };
        ctx.createMediaStreamSource(mic).connect(node);
        /**
         * Connected to the destination through a silent gain node because
         * some browsers suspend a worklet whose output goes nowhere. The
         * gain is zero, so nothing is actually played back -- which would
         * otherwise be the customer hearing themselves.
         */
        const mute = ctx.createGain();
        mute.gain.value = 0;
        node.connect(mute).connect(ctx.destination);
      } catch {
        setPhase('error');
        setErr('No microphone. Allow access and reload.');
      }
    };

    void start();

    return () => {
      closed = true;
      ws.current?.close();
      stream.current?.getTracks().forEach((t) => t.stop());
      void audio.current?.close();
    };
  }, [drain]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const reset = useCallback(async () => {
    await fetch(`${API}/voice/stream/reset`, { method: 'POST' });
    setTurns([]);
    setPartial('');
    setErr(null);
  }, []);

  /** everything on screen, as one block to paste into a message */
  const copyLog = useCallback(() => {
    const text = turns
      .map((t, i) =>
        [
          `--- turn ${i + 1} ---`,
          `HEARD   "${t.heard}"`,
          `ACTION  ${t.action} / ${t.goal}`,
          `SAID    ${t.reply}`,
          `TIMING  first sound ${t.firstSoundMs}ms, total ${t.totalMs}ms`,
        ].join('\n'),
      )
      .join('\n\n');
    void navigator.clipboard?.writeText(text);
  }, [turns]);

  const label: Record<Phase, string> = {
    connecting: 'jud raha hai…',
    ready: 'boliye',
    listening: 'sun raha…',
    thinking: 'soch raha…',
    error: 'band hai',
  };

  return (
    <>
      <h1 className="display text-[clamp(2rem,4vw,2.75rem)]">Voice</h1>
      <p className="muted mt-2 max-w-xl text-sm leading-relaxed">
        The same agent your customers reach on WhatsApp, listening through
        this browser instead of a phone line. Nothing here costs a call.
      </p>

      <section className="pane card-in mt-7 p-6">
        <div className="flex flex-wrap items-center gap-4">
          <div
            className={`grid h-24 w-24 shrink-0 place-items-center rounded-full border-2 border-[var(--ink)] text-sm font-semibold transition-transform select-none ${
              phase === 'listening'
                ? 'scale-110 bg-[var(--hot)] text-[var(--bg)]'
                : phase === 'thinking'
                  ? 'bg-[var(--amber)]'
                  : phase === 'ready'
                    ? 'bg-[var(--accent)]'
                    : 'bg-[#1a1a1a14]'
            }`}
            style={{ boxShadow: '4px 4px 0 var(--ink)' }}
          >
            {label[phase]}
          </div>

          <div className="min-w-[200px] flex-1">
            <p className="text-sm leading-relaxed">
              Just talk. It hears you the moment you start and answers when
              you stop &mdash; no button to hold.
              <br />
              <span className="muted">
                &ldquo;do kilo atta bhej dena&rdquo; &middot; &ldquo;moong dal ka price
                kya hai&rdquo; &middot; &ldquo;haan daal do&rdquo;
              </span>
            </p>
            <div className="mt-3 flex flex-wrap gap-2.5">
              <button
                onClick={() => setMuted((m) => !m)}
                className="rounded-lg border-2 border-[var(--ink)] px-3.5 py-2 text-xs font-semibold"
              >
                {muted ? 'Unmute mic' : 'Mute mic'}
              </button>
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

        {/* the words arriving, which is how you tell a slow agent from a deaf one */}
        {partial && (
          <p className="mt-4 border-t border-[#1a1a1a12] pt-4 text-lg opacity-60">
            {partial}
            <span className="animate-pulse">…</span>
          </p>
        )}

        {err && <p className="mt-4 text-sm text-[var(--warn)]">{err}</p>}
      </section>

      {turns.map((t, i) => (
        <section key={i} className="pane card-in mt-5 p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="muted text-xs">turn {i + 1}</span>
            <span className="muted text-xs tabular-nums">
              first sound <b className="text-[var(--ink)]">{t.firstSoundMs}ms</b>
              {' '}&middot; total {t.totalMs}ms
            </span>
          </div>

          <p className="mt-4 text-xs font-semibold tracking-wide uppercase opacity-60">Heard</p>
          <p className="mt-1 text-lg">&ldquo;{t.heard}&rdquo;</p>

          <p className="mt-4 text-xs font-semibold tracking-wide uppercase opacity-60">
            Said &middot; {t.action} / {t.goal}
          </p>
          <p className="mt-1 text-lg whitespace-pre-wrap">{t.reply}</p>
        </section>
      ))}
    </>
  );
}
