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
export async function speak(text: string): Promise<Spoken | null> {
  if (!env.SARVAM_API_KEY || !text.trim()) return null;

  const speaker = SPEAKERS_V3.includes(env.SARVAM_TTS_SPEAKER)
    ? env.SARVAM_TTS_SPEAKER
    : 'ritu';

  const t0 = Date.now();
  try {
    const res = await fetch(`${env.SARVAM_BASE_URL}/text-to-speech`, {
      method: 'POST',
      headers: {
        'api-subscription-key': env.SARVAM_API_KEY,
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
    });

    if (!res.ok) return null;

    const j = (await res.json()) as { audios?: string[] };
    const b64 = j.audios?.[0];
    if (!b64) return null;

    return {
      audio: Buffer.from(b64, 'base64'),
      latencyMs: Date.now() - t0,
      speaker,
    };
  } catch {
    return null;
  }
}
