import WebSocket from 'ws';
import { env } from '../../config/env.js';

/**
 * THE MOUTH, HELD OPEN, FED WHILE THE MODEL IS STILL WRITING.
 *
 * The batch TTS this sits beside takes a finished sentence and returns a
 * finished WAV, which makes speech the last stage of a pipeline that
 * cannot start until every stage before it has finished. Measured on a
 * real call: the shop said "haan ji" at 1316ms and then went quiet for
 * seven seconds while the composer wrote and the synthesiser rendered.
 *
 * The filler made that WORSE, not better. It proved the line was open and
 * then left a silence that now sounded like a fault rather than latency.
 *
 * This is the other half of the fix that openEar() started. Text goes in
 * as the model produces it and audio comes back before the sentence it
 * belongs to is finished, so the first words are already playing while
 * the rest is still being written.
 *
 * PER SESSION, NEVER GLOBAL. One socket belongs to one conversation, for
 * the same reason one basket does: flush and cancellation are per-turn
 * operations, and a socket shared between two callers would have one
 * customer's barge-in cutting off the other's sentence.
 *
 * CHUNKING IS SARVAM'S JOB, NOT OURS. It would be easy to write a
 * three-to-eight-word splitter here and it would be a mistake -- short
 * fragments synthesised independently have audible seams at the joins,
 * because the prosody of "wala Aashirvaad" depends on what came before
 * it. min_buffer_size and max_chunk_length below let the server decide
 * where to cut, with the whole stream in view. All this file does is stop
 * holding text back.
 */

export interface StreamingMouth {
  /** push text as it is produced. Safe to call with partial clauses. */
  say(text: string): void;
  /** synthesise whatever is buffered, now */
  flush(): void;
  close(): void;
}

export interface MouthHandlers {
  /** one chunk of audio, base64, in the codec configured below */
  onAudio: (b64: string, contentType: string) => void;
  /** the last chunk of this utterance has been generated */
  onDone?: () => void;
  onError?: (message: string) => void;
}

/**
 * linear16 because the browser schedules raw PCM on an AudioContext
 * timeline, and anything encoded would have to be decoded first -- which
 * on a stream means either MediaSource or a decode per chunk, both of
 * which reintroduce the buffering this exists to remove.
 *
 * The buffer sizes are Sarvam's own conversational recommendation. Below
 * about 30 characters the server is synthesising fragments too short to
 * carry prosody; above about 200 it is waiting for text it could already
 * have spoken.
 */
const CONFIG = {
  speaker: env.SARVAM_TTS_SPEAKER,
  language_code: env.SARVAM_TTS_LANGUAGE,
  output_audio_codec: 'linear16',
  min_buffer_size: 40,
  max_chunk_length: 180,
};

export function openMouth(handlers: MouthHandlers): StreamingMouth {
  const key = env.SARVAM_API_KEY ?? '';
  const url = `${env.SARVAM_BASE_URL.replace(/^http/, 'ws')}/text-to-speech/ws`
    + `?model=${encodeURIComponent(env.SARVAM_TTS_MODEL)}&send_completion_event=true`;

  /**
   * Authenticated by SUBPROTOCOL as well as by header. The browser
   * WebSocket API cannot set headers, so Sarvam accepts the key as a
   * protocol token -- and their own SDK sends both. Sending both here
   * too, because which one the server actually reads is not documented
   * and guessing wrong is a handshake failure with no useful message.
   */
  const ws = new WebSocket(url, [`api-subscription-key.${key}`], {
    headers: { 'api-subscription-key': key },
  });

  /**
   * Text spoken before the socket finished opening is not dropped. The
   * composer can produce its first clause in a few hundred milliseconds
   * and the handshake takes about as long; without this, fast turns lose
   * their opening words, which are the ones that matter most.
   */
  const backlog: string[] = [];
  let open = false;
  let flushPending = false;

  const push = (text: string) => {
    ws.send(JSON.stringify({ type: 'text', data: { text } }));
  };

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'config', data: CONFIG }));
    open = true;
    for (const text of backlog.splice(0)) push(text);
    if (flushPending) {
      flushPending = false;
      ws.send(JSON.stringify({ type: 'flush' }));
    }
  });

  ws.on('message', (raw) => {
    let msg: { type?: string; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw.toString()) as typeof msg;
    } catch {
      return;
    }

    if (msg.type === 'audio' && typeof msg.data?.audio === 'string') {
      handlers.onAudio(msg.data.audio, String(msg.data.content_type ?? 'audio/linear16'));
    } else if (msg.type === 'event' && msg.data?.event_type === 'final') {
      handlers.onDone?.();
    } else if (msg.type === 'error') {
      handlers.onError?.(String(msg.data?.message ?? 'unknown'));
    }
  });

  ws.on('error', (err) => handlers.onError?.(err.message));

  /** Sarvam closes an idle socket at about a minute; a shop has pauses */
  const keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, 20_000);
  ws.on('close', () => clearInterval(keepalive));

  return {
    say(text) {
      if (!text.trim()) return;
      if (open && ws.readyState === WebSocket.OPEN) push(text);
      else backlog.push(text);
    },
    flush() {
      if (open && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'flush' }));
      else flushPending = true;
    },
    close() {
      clearInterval(keepalive);
      ws.close();
    },
  };
}
