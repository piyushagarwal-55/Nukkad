import { readFile } from 'node:fs/promises';
import { env, hasShunya } from '../../config/env.js';
import type { Transcription } from './index.js';

/**
 * Shunya Labs zero-indic. An Indian-language ASR trained on real Indian
 * accents and native code-switching.
 *
 * WHY IT IS HERE. Whisper on language=hi returns Devanagari, which the
 * resolver cannot read, so that path costs a second LLM call to
 * transliterate. Shunya on language_code=en returns ROMAN DIRECTLY, which
 * removes the hop entirely.
 *
 * Measured on one clip, same resolver, same three items asked for:
 *
 *   whisper hi -> romanise   2292ms   3 of 3 found
 *   shunya  en               1588ms   3 of 3 found
 *   shunya  hi -> romanise    838ms   0 of 3   (output was garbled)
 *
 * So en, not hi. And the 700ms it saves is 700ms of dead air on a phone
 * call, which is the difference between an agent that sounds like it is
 * listening and one that sounds broken.
 *
 * TREAT THAT MEASUREMENT AS PROVISIONAL. The clip was a US English speech
 * synthesiser reading Hinglish, which is the one thing these models are
 * NOT tuned for and Whisper is. A recording of an actual person is the
 * test that decides this, and it has not been run.
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
