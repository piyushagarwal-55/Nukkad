import { createReadStream } from 'node:fs';
import { groq } from '../../lib/groq.js';
import { env, hasSarvam } from '../../config/env.js';

export interface Transcription {
  text: string;
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
  return { text: (res as { text: string }).text.trim(), engine: model, latencyMs: Date.now() - t0 };
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
  return {
    text: (j.transcript ?? '').trim(),
    engine: `${env.SARVAM_MODEL}:${env.SARVAM_MODE}`,
    latencyMs: Date.now() - t0,
  };
}
