import { mark, span } from '../telemetry/span.js';
import { env } from '../../config/env.js';

/**
 * Sarvam bulbul, the shop's speaking voice.
 *
 * Same key as the ear -- saaras does the listening in services/asr -- so
 * the whole voice loop needs no account the project did not already have.
 * That mattered more than the model quality when choosing: ElevenLabs
 * sounds better and costs a signup, a free tier that runs out, and a
 * second thing to keep working on demo day.
 *
 * MEASURED, on one sentence of Hinglish: about two seconds. That is slow
 * enough to matter and worth being honest about -- see the latency note
 * in voice/turn.ts for where it sits in the round trip and what to do
 * about it.
 *
 * bulbul:v2 is deprecated and its speaker names are gone with it; v3
 * wants aditya, ritu, priya, rahul and friends. A stale speaker name
 * fails the whole call with a 400, so the default here is a v3 one.
 */

const SPEAKERS_V3 = ['aditya', 'ritu', 'priya', 'rahul', 'pooja', 'rohan'];

export interface Spoken {
  /** WAV bytes, ready to play or hand to a phone */
  audio: Buffer;
  latencyMs: number;
  speaker: string;
}

/**
 * Returns null rather than throwing on any failure.
 *
 * A voice turn that produces text but no audio is still a working turn --
 * the caller can show the words, and on a phone it can fall back to
 * Twilio's own <Say>. Losing the whole reply because a TTS provider
 * hiccuped would be the worse trade.
 */
/**
 * THE SHORT LINES THIS SHOP SAYS OVER AND OVER, SYNTHESISED ONCE.
 *
 * "Haan ji...", "Ek second, dekhta hoon...", "Namaste! Kya chahiye aaj?"
 * -- a fixed vocabulary of reactions and fast-path replies, each of which
 * was costing a 600-900ms round trip EVERY time it was said. On the
 * reaction that is the whole point of the reaction: it exists to break a
 * silence at 700ms and was arriving at 1300ms.
 *
 * Capped and short-only, because the thing that must not happen is an
 * unbounded map of every sentence a shop has ever spoken. Long replies
 * are one-offs -- they carry names, prices and quantities -- so they
 * would never be hit again and would only push out the entries that are.
 */
const CACHE_MAX_CHARS = 80;
const CACHE_MAX_ENTRIES = 64;
const cache = new Map<string, Spoken>();

function remember(text: string, said: Spoken): void {
  if (text.length > CACHE_MAX_CHARS) return;
  // oldest out first: insertion order is what Map iteration gives us
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(text, said);
}

export async function speak(text: string): Promise<Spoken | null> {
  if (!env.SARVAM_API_KEY || !text.trim()) return null;

  const hit = cache.get(text);
  if (hit) {
    mark('tts', 'hit');
    // latency reported as zero because that is what the caller experienced
    return { ...hit, latencyMs: 0 };
  }

  // captured so the narrowing survives into the span closure below
  const key = env.SARVAM_API_KEY;

  const speaker = SPEAKERS_V3.includes(env.SARVAM_TTS_SPEAKER)
    ? env.SARVAM_TTS_SPEAKER
    : 'ritu';

  const t0 = Date.now();
  try {
    const res = await span('tts', () => fetch(`${env.SARVAM_BASE_URL}/text-to-speech`, {
      method: 'POST',
      headers: {
        'api-subscription-key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        /**
         * The ledger is stripped before this point -- see turn.ts. Reading
         * a table of quantities and a total out loud is unbearable, and
         * on a phone there is nothing to look at anyway.
         */
        text: text.slice(0, 1500),
        target_language_code: env.SARVAM_TTS_LANGUAGE,
        speaker,
        model: env.SARVAM_TTS_MODEL,
      }),
    }));

    if (!res.ok) return null;

    const j = (await res.json()) as { audios?: string[] };
    const b64 = j.audios?.[0];
    if (!b64) return null;

    const said: Spoken = {
      audio: Buffer.from(b64, 'base64'),
      latencyMs: Date.now() - t0,
      speaker,
    };
    remember(text, said);
    return said;
  } catch {
    return null;
  }
}
