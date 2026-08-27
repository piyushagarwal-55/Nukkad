import { createReadStream } from 'node:fs';
import { groq } from '../../lib/groq.js';
import { env, hasSarvam } from '../../config/env.js';
import { romanise, isRoman } from '../lang/romanise.js';
import { transcribeShunya } from './shunya.js';

export interface Transcription {
  /** Roman, ready for the resolver */
  text: string;
  /** exactly what the engine returned, script and all. Never overwritten. */
  raw: string;
  engine: string;
  latencyMs: number;
}

/**
 * Whisper is measurably WORSE than Sarvam on code-mixed Hinglish, and
 * that is fine, arguably better. The whole thesis is that transcription
 * errors are recoverable by retrieval, because the answer is guaranteed
 * to be inside a few hundred known SKUs with a strong household prior.
 * A noisier transcript makes the catalogue-constraint row of the ablation
 * table jump HIGHER, not lower. The delta is the product.
 */
/**
 * The one call everything else should make.
 *
 * Shunya first when it is configured, because it returns Roman directly
 * and saves the transliteration hop -- measured at 1588ms against 2292ms
 * for Whisper plus romanise, both finding all three items. It returns null
 * rather than throwing on any failure, so Whisper is a real fallback and
 * not a theoretical one.
 */
export async function transcribe(path: string, fast = false): Promise<Transcription> {
  return (await transcribeShunya(path)) ?? (await transcribeGroq(path, fast));
}

export async function transcribeGroq(path: string, fast = false): Promise<Transcription> {
  const model = fast ? env.GROQ_ASR_MODEL_FAST : env.GROQ_ASR_MODEL;
  const t0 = Date.now();
  const res = await groq.audio.transcriptions.create({
    file: createReadStream(path) as never,
    model,
    // Explicit language. Auto-detect flip-flops between hi and en
    // mid-utterance on Hinglish and returns mush.
    language: env.GROQ_ASR_LANGUAGE,
    temperature: 0,
  });
  const raw = (res as { text: string }).text.trim();

  /**
   * language=hi returns DEVANAGARI, and the resolver strips it to nothing.
   * Converting here rather than at every call site means one boundary
   * instead of four, and the original stays on `raw` so the orders page
   * can show what was actually heard.
   */
  const text = isRoman(raw) ? raw : await romanise(raw);

  return { text, raw, engine: model, latencyMs: Date.now() - t0 };
}

/**
 * Optional second engine. Not a dependency. Its only job is to add a row
 * to the ablation table that says "ranking rescues BOTH engines", which
 * is a much stronger claim than rescuing one.
 */
export async function transcribeSarvam(path: string): Promise<Transcription | null> {
  if (!hasSarvam) return null;
  const t0 = Date.now();
  const fs = await import('node:fs');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(path)]), 'audio.ogg');
  form.append('model', env.SARVAM_MODEL);
  form.append('mode', env.SARVAM_MODE);

  const res = await fetch(`${env.SARVAM_BASE_URL}/speech-to-text`, {
    method: 'POST',
    headers: { 'api-subscription-key': env.SARVAM_API_KEY! },
    body: form,
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { transcript?: string };
  const raw = (j.transcript ?? '').trim();

  // Sarvam's codemix mode usually returns Roman already, but not always,
  // and the resolver cannot tell the difference. Same boundary either way.
  return {
    text: isRoman(raw) ? raw : await romanise(raw),
    raw,
    engine: `${env.SARVAM_MODEL}:${env.SARVAM_MODE}`,
    latencyMs: Date.now() - t0,
  };
}
