import WebSocket from 'ws';
import { env } from '../../config/env.js';

/**
 * THE EAR, HELD OPEN.
 *
 * The batch API this replaces made every turn pay for a whole pipeline in
 * series: the customer finishes speaking, the browser assembles a blob,
 * uploads it, Sarvam decodes and transcribes the entire clip, and only
 * then does anything downstream begin. Measured on a real call, the first
 * turn spent 4603ms in `ear` alone -- a TLS handshake and a cold model --
 * against 537ms on the second. Nothing about the first utterance was
 * harder. It was paying to open a door.
 *
 * saaras:v3-realtime holds the door open. Audio goes up as it is spoken,
 * partial transcripts come back while the customer is still talking, and
 * the final arrives when they stop rather than a round trip later. The
 * connection is made once per session, so no turn pays for it.
 *
 * WHY THIS SITS ON THE SERVER AND NOT IN THE BROWSER, which is the first
 * question anyone should ask of a design that adds a hop. The API key.
 * Sarvam authenticates the WebSocket handshake with a subscription key,
 * and a key shipped to a browser is a key published. So the browser talks
 * to us and we talk to Sarvam, which also means the transcript reaches
 * the agent without a second round trip through the client.
 *
 * WHAT PARTIALS ARE FOR, AND WHAT THEY ARE NOT FOR. They are permission
 * to PREPARE and never permission to ACT. "do kilo aashirvaad" is a
 * prefix of "do kilo aashirvaad atta daal do" and also of "do kilo
 * aashirvaad atta nahi chahiye", and a system that put something in a
 * basket on the first would have to take it out on the second. So the
 * speculative work is strictly read-only -- see the note on the final
 * event in routes/stream.ts. Only `transcript.final` commits anything.
 */

export interface RealtimeEar {
  /** ~100ms of 16-bit mono PCM at 16kHz */
  send(pcm: Buffer): void;
  /** closes the socket, ending the session */
  close(): void;
  /** true once Sarvam has acknowledged the session */
  readonly ready: boolean;
}

export interface EarHandlers {
  /** interim text, revised as they keep speaking. Never act on it. */
  onPartial?: (text: string) => void;
  /** an utterance, complete. This is the only thing that may commit. */
  onFinal: (text: string, language: string | null) => void;
  /** server-side VAD heard speech begin */
  onSpeechStart?: () => void;
  /** server-side VAD heard it end */
  onSpeechEnd?: () => void;
  onError?: (message: string, fatal: boolean) => void;
  onClose?: () => void;
}

/**
 * `translit` for the same reason the batch path uses it: the resolver and
 * the composer both work in Roman Hinglish, and Devanagari coming back
 * would be stripped to nothing by normalise(). See the fold table in
 * scripts/fold.ts for what the matcher actually expects to be handed.
 *
 * `balanced` rather than `fast`, because a wrong word costs a wrong
 * product and the partials are not being acted on anyway -- latency on a
 * partial buys nothing that the final does not already give.
 */
const PARAMS = {
  model: 'saaras:v3-realtime',
  language_code: 'auto',
  mode: 'translit',
  stream_type: 'balanced',
  endpointing: 'vad',
  encoding: 'linear16',
  sample_rate: '16000',
  /**
   * Half a second of silence ends a turn. Shorter and the shop
   * interrupts someone drawing breath mid-list -- "do kilo atta... aur
   * ek kilo chini" is one order and two utterances at 300ms. Longer and
   * every turn carries the wait.
   */
  silence_duration_ms: '500',
  min_speech_duration_ms: '250',
};

type EarParamOverrides = Partial<Record<keyof typeof PARAMS | 'threshold', string>>;

export function openEar(
  handlers: EarHandlers,
  opts: EarParamOverrides = {},
): RealtimeEar {
  const url = `${env.SARVAM_BASE_URL.replace(/^http/, 'ws')}/speech-to-text-realtime/ws`
    + `?${new URLSearchParams({ ...PARAMS, ...opts }).toString()}`;

  const ws = new WebSocket(url, {
    headers: { 'api-subscription-key': env.SARVAM_API_KEY ?? '' },
  });

  let ready = false;

  /**
   * AUDIO SPOKEN BEFORE THE SOCKET OPENED IS NOT DROPPED.
   *
   * The customer can start talking the instant the page is ready, and the
   * handshake takes a few hundred milliseconds. Without this the first
   * syllable of the first turn goes missing, which is exactly the word
   * most likely to be the product.
   */
  const backlog: Buffer[] = [];

  const push = (pcm: Buffer) => {
    ws.send(JSON.stringify({ event: 'audio_input', audio: pcm.toString('base64') }));
  };

  ws.on('open', () => {
    ready = true;
    for (const chunk of backlog.splice(0)) push(chunk);
  });

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg.event) {
      case 'transcript.partial':
        if (typeof msg.text === 'string' && msg.text.trim()) handlers.onPartial?.(msg.text);
        break;

      case 'transcript.final':
        if (typeof msg.text === 'string' && msg.text.trim()) {
          handlers.onFinal(msg.text, typeof msg.language === 'string' ? msg.language : null);
        }
        break;

      case 'vad.speech_start':
        handlers.onSpeechStart?.();
        break;

      case 'vad.speech_end':
        handlers.onSpeechEnd?.();
        break;

      case 'error':
        handlers.onError?.(String(msg.message ?? 'unknown'), msg.is_fatal === true);
        break;
    }
  });

  ws.on('error', (err) => handlers.onError?.(err.message, true));
  ws.on('close', () => {
    ready = false;
    handlers.onClose?.();
  });

  /**
   * Sarvam closes an idle socket. A ping every twenty seconds is far
   * inside that and costs nothing, and it keeps the connection warm
   * through the long pauses a shopping conversation actually has.
   */
  const keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'ping' }));
  }, 20_000);
  ws.on('close', () => clearInterval(keepalive));

  return {
    get ready() {
      return ready;
    },
    send(pcm) {
      if (ws.readyState === WebSocket.OPEN) push(pcm);
      else if (ws.readyState === WebSocket.CONNECTING) backlog.push(pcm);
    },
    close() {
      clearInterval(keepalive);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'end' }));
      ws.close();
    },
  };
}
