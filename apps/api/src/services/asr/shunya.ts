import { readFile } from 'node:fs/promises';
import { env, hasShunya } from '../../config/env.js';
import type { Transcription } from './index.js';

/**
 * Shunya Labs zero-indic. An Indian-language ASR trained on real Indian
 * accents and native code-switching.
 *
 * SECOND IN THE CHAIN, behind Sarvam. See `transcribe` in ./index.ts for
 * the table that decided that; the short version is that both engines land
 * tel and chai patti, and only Sarvam hears atta.
 *
 * It stays in the chain rather than being deleted, and not out of sentiment.
 * Sarvam is one vendor with one key and one outage away from a mute voice
 * agent, and the layer under it should be something that also answers in
 * Roman. Whisper alone would work, but it costs an extra LLM call to
 * transliterate and doubles the latency.
 *
 * WHY language_code=en ON HINDI AUDIO. Because hi returns Devanagari, which
 * the resolver strips to an empty string. Measured on the same clip:
 *
 *   shunya en               382-1547ms   2 of 3 found
 *   shunya hi -> romanise         838ms  0 of 3   (garbled)
 *
 * The wide range is the token exchange: the first call pays ~800ms for it
 * and every later one does not.
 */

/**
 * Auth is two-legged: the API key buys a short-lived token, and only the
 * token may touch the transcription endpoint. Cached because the exchange
 * costs 800ms and a voice call cannot spend that per utterance.
 */
let token: { value: string; expires: number } | null = null;
const TOKEN_TTL_MS = 25 * 60 * 1000;

async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expires) return token.value;

  const res = await fetch(`${env.SHUNYA_AUTH_URL}/api/auth/token`, {
    method: 'POST',
    headers: { 'api-key': env.SHUNYA_API_KEY!, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`shunya auth ${res.status}`);

  const j = (await res.json()) as { token?: string };
  if (!j.token) throw new Error('shunya auth returned no token');

  token = { value: j.token, expires: Date.now() + TOKEN_TTL_MS };
  return j.token;
}

export async function transcribeShunya(path: string): Promise<Transcription | null> {
  if (!hasShunya) return null;

  const t0 = Date.now();
  try {
    const bytes = await readFile(path);
    const form = new FormData();
    form.append('model', env.SHUNYA_MODEL);
    // en, deliberately. See the note above: hi returns Devanagari and,
    // on the one clip measured, garbled Devanagari at that.
    form.append('language_code', env.SHUNYA_LANGUAGE);
    form.append('file', new Blob([new Uint8Array(bytes)]), 'audio.wav');

    const res = await fetch(`${env.SHUNYA_BASE_URL}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}` },
      body: form,
    });
    if (!res.ok) {
      // a stale token is the likely cause; drop it so the next call re-auths
      if (res.status === 401) token = null;
      return null;
    }

    const j = (await res.json()) as { text?: string; transcript?: string };
    const raw = (j.text ?? j.transcript ?? '').trim();
    if (!raw) return null;

    return { text: raw, raw, engine: env.SHUNYA_MODEL, latencyMs: Date.now() - t0 };
  } catch {
    // never fatal: the caller falls back to Whisper
    return null;
  }
}
