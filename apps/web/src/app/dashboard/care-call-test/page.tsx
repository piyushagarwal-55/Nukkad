'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, MicOff, PhoneCall, RefreshCcw, Send, Square } from 'lucide-react';
import { API, get, post } from '@/lib/api';

type Phase = 'idle' | 'connecting' | 'ready' | 'listening' | 'thinking' | 'closed' | 'error';

interface CarePlan {
  household: { id: string; name: string; phone: string };
  lines: Array<{ skuId: string; name: string; quantityHint: number | null; daysSincePurchase: number | null }>;
  openingScript: string;
}

interface SessionResponse {
  sessionId: string;
  household: { id: string; name: string; phone: string };
  lines: CarePlan['lines'];
  openingScript: string;
  contextScript: string;
}

interface Turn {
  stage: string;
  heard: string;
  reply: string;
  action: string;
  totalMs: number;
  agentText?: string;
  outcome?: {
    name: string;
    preconditions: string[];
    tools: string[];
    nextStage: string;
    verified: boolean;
  };
  memory?: {
    desk: string;
    previousDesk: string | null;
    state: string;
    turn: number;
    pending: {
      type: string;
      product: string | null;
      quantity: number | null;
      expiresAfterTurns: number;
    } | null;
    referents: {
      lastProduct: string | null;
      lastOptions: string[];
      lastOrderRef: string | null;
    };
    lastBotQuestion: string | null;
  };
}

const SAMPLE_RATE = 24000;

export default function CareCallTestPage() {
  const [plans, setPlans] = useState<CarePlan[]>([]);
  const [householdId, setHouseholdId] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [partial, setPartial] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [typed, setTyped] = useState('');
  const [muted, setMuted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [session, setSession] = useState<SessionResponse | null>(null);

  const ws = useRef<WebSocket | null>(null);
  const inputCtx = useRef<AudioContext | null>(null);
  const outputCtx = useRef<AudioContext | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const mutedRef = useRef(false);
  const sources = useRef<AudioBufferSourceNode[]>([]);
  const nextPlayTime = useRef(0);

  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.household.id === householdId) ?? plans[0] ?? null,
    [plans, householdId],
  );

  useEffect(() => {
    get<{ plans: CarePlan[] }>('/care-calls/due?days=14')
      .then((res) => {
        setPlans(res.plans);
        setHouseholdId((current) => current || res.plans[0]?.household.id || '');
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const speaker = useCallback(() => {
    outputCtx.current ??= new AudioContext({ sampleRate: SAMPLE_RATE });
    return outputCtx.current;
  }, []);

  const hush = useCallback(() => {
    for (const src of sources.current) {
      try {
        src.stop();
      } catch {
        // already ended
      }
    }
    sources.current = [];
    nextPlayTime.current = 0;
  }, []);

  const play = useCallback((b64: string) => {
    const ctx = speaker();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (!samples.length) return;

    const buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    const channel = buf.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 0x8000;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(nextPlayTime.current, ctx.currentTime);
    src.start(startAt);
    nextPlayTime.current = startAt + buf.duration;
    sources.current.push(src);
    src.onended = () => {
      sources.current = sources.current.filter((item) => item !== src);
    };
  }, [speaker]);

  const cleanup = useCallback(() => {
    hush();
    ws.current?.close();
    ws.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void inputCtx.current?.close();
    inputCtx.current = null;
    setPhase('closed');
  }, [hush]);

  const start = useCallback(async () => {
    if (!selectedPlan) return;
    cleanup();
    setTurns([]);
    setPartial('');
    setErr(null);
    setPhase('connecting');

    try {
      const nextSession = await post<SessionResponse>('/care-calls/test/session', {
        householdId: selectedPlan.household.id,
        days: 14,
      });
      setSession(nextSession);

      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      stream.current = mic;

      const ctx = new AudioContext({ sampleRate: 16000 });
      inputCtx.current = ctx;
      await ctx.audioWorklet.addModule('/pcm-worklet.js');

      const socket = new WebSocket(`${API.replace(/^http/, 'ws')}/care-calls/test/stream`);
      socket.binaryType = 'arraybuffer';
      ws.current = socket;

      socket.onopen = () => {
        setPhase('ready');
        socket.send(JSON.stringify({ type: 'start', sessionId: nextSession.sessionId }));
      };
      socket.onclose = () => setPhase((p) => (p === 'closed' ? p : 'closed'));
      socket.onerror = () => {
        setErr('Care-call test socket disconnected.');
        setPhase('error');
      };
      socket.onmessage = (e) => {
        const ev = JSON.parse(e.data as string) as
          | { type: 'opened'; household: string; prompt: string }
          | { type: 'partial'; text: string }
          | { type: 'listening' }
          | { type: 'thinking' }
          | { type: 'audio'; b64: string }
          | ({ type: 'turn' } & Turn)
          | { type: 'closed' }
          | { type: 'error'; message: string };

        if (ev.type === 'opened') {
          setTurns((current) => [
            ...current,
            { stage: 'PERMISSION', action: 'CALL_OPENED', heard: '', reply: ev.prompt, totalMs: 0 },
          ]);
        } else if (ev.type === 'partial') {
          setPartial(ev.text);
          setPhase('listening');
        } else if (ev.type === 'listening') {
          hush();
          setPhase('listening');
        } else if (ev.type === 'thinking') {
          setPhase('thinking');
        } else if (ev.type === 'audio') {
          play(ev.b64);
        } else if (ev.type === 'turn') {
          setTurns((current) => [...current, ev]);
          setPartial('');
          setPhase('ready');
        } else if (ev.type === 'closed') {
          setPhase('closed');
        } else if (ev.type === 'error') {
          setErr(ev.message);
          setPhase('error');
        }
      };

      const node = new AudioWorkletNode(ctx, 'pcm-worklet');
      node.port.onmessage = (e) => {
        if (mutedRef.current) return;
        if (socket.readyState === WebSocket.OPEN) socket.send(e.data as Int16Array);
      };
      ctx.createMediaStreamSource(mic).connect(node);
      const silent = ctx.createGain();
      silent.gain.value = 0;
      node.connect(silent).connect(ctx.destination);
    } catch (e) {
      setErr((e as Error).message || 'Care-call test start nahi hua.');
      setPhase('error');
    }
  }, [cleanup, hush, play, selectedPlan]);

  useEffect(() => () => cleanup(), [cleanup]);

  const sendTyped = useCallback(() => {
    const text = typed.trim();
    if (!text || ws.current?.readyState !== WebSocket.OPEN) return;
    hush();
    ws.current.send(JSON.stringify({ type: 'text', text }));
    setTyped('');
    setPhase('thinking');
  }, [hush, typed]);

  const copyLog = useCallback(() => {
    const text = turns
      .map((turn, index) => [
        `--- care call turn ${index + 1} ---`,
        `STAGE  ${turn.stage}`,
        `ACT    ${turn.action}`,
        turn.outcome ? `OUTCOME ${turn.outcome.name} -> ${turn.outcome.nextStage}` : null,
        turn.outcome?.tools.length ? `TOOLS  ${turn.outcome.tools.join(', ')}` : null,
        turn.memory ? `MEMORY desk=${turn.memory.desk} state=${turn.memory.state} pending=${turn.memory.pending?.type ?? 'none'}` : null,
        turn.agentText ? `AGENT  "${turn.agentText}"` : null,
        turn.heard ? `HEARD  "${turn.heard}"` : null,
        `BOT    ${turn.reply}`,
        `TIME   ${turn.totalMs}ms`,
      ].filter(Boolean).join('\n'))
      .join('\n\n');
    void navigator.clipboard?.writeText(text);
  }, [turns]);

  const phaseLabel: Record<Phase, string> = {
    idle: 'ready',
    connecting: 'connecting',
    ready: 'listening',
    listening: 'hearing',
    thinking: 'thinking',
    closed: 'closed',
    error: 'check',
  };

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="display text-[clamp(2rem,4vw,2.75rem)]">Care Call Test</h1>
          <p className="muted mt-2 max-w-2xl text-sm leading-relaxed">
            Test the outbound customer call in browser voice mode. It uses the same care-call
            permission flow, due basket, JSON intent reader, order brain, and Sarvam voice, with no Twilio call charge.
          </p>
        </div>
        <button
          onClick={start}
          disabled={!selectedPlan || phase === 'connecting'}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
        >
          <PhoneCall className="h-4 w-4" />
          Start test call
        </button>
      </div>

      <section className="mt-6 grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="rounded-[22px] bg-[#eef2ff] p-5 shadow-[0_18px_48px_-34px_rgba(79,70,229,0.65)]">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="grid h-24 w-24 shrink-0 place-items-center rounded-full bg-white text-sm font-semibold text-[var(--accent)] shadow-sm">
              {phaseLabel[phase]}
            </div>
            <div className="min-w-0 flex-1">
              <label className="text-xs font-semibold uppercase text-[var(--muted)]">Customer</label>
              <select
                value={householdId}
                onChange={(e) => setHouseholdId(e.target.value)}
                disabled={phase === 'listening' || phase === 'thinking'}
                className="mt-2 w-full rounded-xl bg-white px-3 py-3 text-sm shadow-sm outline-none"
              >
                {plans.map((plan) => (
                  <option key={plan.household.id} value={plan.household.id}>
                    {plan.household.name} · {plan.household.phone}
                  </option>
                ))}
              </select>

              <div className="mt-4 flex flex-wrap gap-2">
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') sendTyped();
                  }}
                  placeholder="Type reply instead of speaking..."
                  className="min-w-[220px] flex-1 rounded-xl bg-white px-3 py-2.5 text-sm shadow-sm outline-none"
                />
                <button onClick={sendTyped} className="grid h-10 w-10 place-items-center rounded-xl bg-white shadow-sm" title="Send">
                  <Send className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setMuted((value) => !value)}
                  className="grid h-10 w-10 place-items-center rounded-xl bg-white shadow-sm"
                  title={muted ? 'Unmute mic' : 'Mute mic'}
                >
                  {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </button>
                <button onClick={cleanup} className="grid h-10 w-10 place-items-center rounded-xl bg-white shadow-sm" title="Stop">
                  <Square className="h-4 w-4" />
                </button>
                <button onClick={copyLog} className="grid h-10 w-10 place-items-center rounded-xl bg-white shadow-sm" title="Copy log">
                  <RefreshCcw className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {partial && (
            <p className="mt-5 rounded-2xl bg-white px-4 py-3 text-sm text-[var(--muted)] shadow-sm">
              Hearing: {partial}<span className="animate-pulse">...</span>
            </p>
          )}
          {err && <p className="mt-4 text-sm text-[#b91c1c]">{err}</p>}
        </div>

        <aside className="rounded-[22px] bg-[#fffbeb] p-5 shadow-[0_18px_46px_-34px_rgba(245,158,11,0.55)]">
          <h2 className="text-sm font-semibold uppercase text-[var(--muted)]">Due basket</h2>
          <div className="mt-4 space-y-2">
            {(session?.lines ?? selectedPlan?.lines ?? []).slice(0, 5).map((line) => (
              <div key={line.skuId} className="rounded-xl bg-white px-3 py-2 text-sm shadow-sm">
                <p className="font-semibold">{line.name}</p>
                <p className="muted text-xs">
                  {line.daysSincePurchase !== null ? `${line.daysSincePurchase}d since purchase` : 'learning'}
                  {line.quantityHint !== null ? ` · qty ${line.quantityHint}` : ''}
                </p>
              </div>
            ))}
            {!selectedPlan && <p className="muted text-sm">No care-call customer due right now.</p>}
          </div>
        </aside>
      </section>

      <section className="mt-6 space-y-4">
        {turns.map((turn, index) => (
          <div key={`${turn.stage}-${index}`} className="rounded-[20px] bg-[#f7f7ff] p-5 shadow-[0_16px_42px_-34px_rgba(24,24,27,0.45)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-[var(--accent)]">
                  {turn.stage}
                </span>
                <span className="rounded-full bg-[#ecfdf5] px-2.5 py-1 text-xs font-semibold text-[#047857]">
                  {turn.action}
                </span>
                {turn.outcome && (
                  <span className="rounded-full bg-[#fff7ed] px-2.5 py-1 text-xs font-semibold text-[#c2410c]">
                    {turn.outcome.name}
                  </span>
                )}
              </div>
              <span className="text-xs text-[var(--muted)]">{(turn.totalMs / 1000).toFixed(1)}s</span>
            </div>
            {turn.outcome && (
              <div className="mt-3 grid gap-2 rounded-xl bg-white px-3 py-3 text-xs text-[var(--muted)] sm:grid-cols-3">
                <p>
                  <span className="block font-semibold uppercase text-[#18181b]">State</span>
                  {turn.stage} {'->'} {turn.outcome.nextStage}
                </p>
                <p>
                  <span className="block font-semibold uppercase text-[#18181b]">Tools</span>
                  {turn.outcome.tools.length ? turn.outcome.tools.join(', ') : 'none'}
                </p>
                <p>
                  <span className="block font-semibold uppercase text-[#18181b]">Verified</span>
                  {turn.outcome.verified ? 'yes' : 'needs check'}
                </p>
              </div>
            )}
            {turn.memory && (
              <div className="mt-3 grid gap-2 rounded-xl bg-[#ecfeff] px-3 py-3 text-xs text-[#155e75] sm:grid-cols-4">
                <p>
                  <span className="block font-semibold uppercase text-[#164e63]">Desk</span>
                  {turn.memory.previousDesk ? `${turn.memory.previousDesk} -> ` : ''}{turn.memory.desk}
                </p>
                <p>
                  <span className="block font-semibold uppercase text-[#164e63]">State</span>
                  {turn.memory.state}
                </p>
                <p>
                  <span className="block font-semibold uppercase text-[#164e63]">Pending</span>
                  {turn.memory.pending ? `${turn.memory.pending.type} (${turn.memory.pending.expiresAfterTurns})` : 'none'}
                </p>
                <p>
                  <span className="block font-semibold uppercase text-[#164e63]">Turn</span>
                  {turn.memory.turn}
                </p>
              </div>
            )}
            {turn.agentText && turn.agentText !== turn.heard && (
              <p className="mt-3 rounded-xl bg-[#eef2ff] px-3 py-2 text-sm text-[#3730a3]">
                <span className="font-semibold">Agent input: </span>{turn.agentText}
              </p>
            )}
            {turn.heard && (
              <p className="mt-3 rounded-xl bg-white px-3 py-2 text-sm">
                <span className="font-semibold">Heard: </span>{turn.heard}
              </p>
            )}
            <p className="mt-2 rounded-xl bg-[#18181b] px-3 py-2 text-sm leading-6 text-white">
              <span className="font-semibold">Bot: </span>{turn.reply}
            </p>
          </div>
        ))}
      </section>
    </>
  );
}
