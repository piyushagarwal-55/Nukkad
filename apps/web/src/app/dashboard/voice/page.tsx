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
  /** which desk answered, and where the turn started when it crossed one */
  desk?: string | null;
  from?: string | null;
  handoff?: boolean;
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
  const [typed, setTyped] = useState('');

  const ws = useRef<WebSocket | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const mutedRef = useRef(false);

  /**
   * AUDIO ARRIVES AS RAW PCM AND IS SCHEDULED ON A TIMELINE.
   *
   * The old version received complete WAV files and played each with `new
   * Audio(data:...)`, one after the next. That works when a whole reply
   * is synthesised at once and cannot work now: chunks arrive every ~70ms
   * while the sentence is still being generated, and an <audio> element
   * per chunk would put a gap at every join.
   *
   * So each chunk becomes an AudioBuffer and is scheduled at
   * `nextPlayTime`, which only ever moves forward by exactly the duration
   * of what was queued. Network jitter therefore cannot produce a gap:
   * chunk three is already booked to start the moment chunk two ends,
   * whether it arrived early or late.
   *
   * 24000Hz is bulbul:v3's streaming rate. Sarvam sends `audio/pcm` with
   * no rate attached, so this is the one number here that is asserted
   * rather than read -- and it is audible if wrong, since the wrong rate
   * makes the shopkeeper sound like a chipmunk or a ghost.
   */
  const SAMPLE_RATE = 24000;
  const nextPlayTime = useRef(0);
  const sources = useRef<AudioBufferSourceNode[]>([]);
  const out = useRef<AudioContext | null>(null);

  /**
   * A SECOND CONTEXT, FOR THE OTHER DIRECTION.
   *
   * The capture context runs at 16000Hz because that is what the
   * recogniser takes; the synthesiser returns 24000Hz. Playing one
   * through the other means a resample on every chunk, done by the
   * browser at whatever quality it feels like, for no reason -- an
   * AudioContext is cheap and a mismatched rate is audible.
   */
  const speaker = useCallback(() => {
    out.current ??= new AudioContext({ sampleRate: SAMPLE_RATE });
    return out.current;
  }, []);

  const play = useCallback((b64: string) => {
    const ctx = speaker();
    if (!ctx) return;

    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (!samples.length) return;

    const buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    const channel = buf.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 0x8000;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    /**
     * Never schedule in the past. If the queue has drained -- the model
     * paused, or this is the first chunk of a turn -- start now; if it
     * has not, start exactly where the last chunk ends.
     */
    const startAt = Math.max(nextPlayTime.current, ctx.currentTime);
    src.start(startAt);
    nextPlayTime.current = startAt + buf.duration;

    sources.current.push(src);
    src.onended = () => {
      sources.current = sources.current.filter((s) => s !== src);
    };
  }, [speaker]);

  /** barge-in: stop everything queued, not just what is audible */
  const hush = useCallback(() => {
    for (const src of sources.current) {
      try {
        src.stop();
      } catch {
        // already finished, which is the common case
      }
    }
    sources.current = [];
    nextPlayTime.current = 0;
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
            | { type: 'pause'; ms: number }
            | ({ type: 'turn' } & Trace)
            | { type: 'error'; message: string }
            | { type: 'ear-closed' };

          if (ev.type === 'partial') {
            setPartial(ev.text);
            setPhase('listening');
          } else if (ev.type === 'listening') {
            // barge-in: they started talking, so stop the shop mid-sentence
            hush();
            setPhase('listening');
          } else if (ev.type === 'thinking') {
            setPhase('thinking');
          } else if (ev.type === 'audio') {
            play(ev.b64);
          } else if (ev.type === 'pause') {
            /**
             * The breath in a handover: the next scheduled chunk starts
             * this much later, so the old desk finishes, the line goes
             * quiet for a beat, and a different voice picks up. Silence
             * is the thing that makes the transfer audible as a transfer.
             */
            const ctx = speaker();
            nextPlayTime.current =
              Math.max(nextPlayTime.current, ctx.currentTime) + ev.ms / 1000;
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
      void out.current?.close();
    };
  }, [play, hush]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  /** a typed turn: same pipeline as speech, entered at the final-transcript door */
  const sendTyped = useCallback(() => {
    const text = typed.trim();
    if (!text || ws.current?.readyState !== WebSocket.OPEN) return;
    hush(); // typing over the shop is barge-in too
    ws.current.send(JSON.stringify({ type: 'text', text }));
    setTyped('');
    setPhase('thinking');
  }, [typed, hush]);

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
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendTyped();
                }}
                placeholder="ya yahan type karke test karein…"
                className="min-w-[220px] flex-1 rounded-lg border-2 border-[var(--ink)] bg-[var(--panel,transparent)] px-3 py-2 text-sm"
              />
              <button
                onClick={sendTyped}
                className="rounded-lg border-2 border-[var(--ink)] bg-[var(--accent)] px-3.5 py-2 text-xs font-semibold"
              >
                Send
              </button>
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
            {t.desk ? (
              <span className="ml-2 rounded border border-[var(--ink)] px-1.5 py-0.5 normal-case">
                {t.handoff && t.from ? `${t.from} → ${t.desk}` : t.desk}
              </span>
            ) : null}
          </p>
          <p className="mt-1 text-lg whitespace-pre-wrap">{t.reply}</p>
        </section>
      ))}
    </>
  );
}
