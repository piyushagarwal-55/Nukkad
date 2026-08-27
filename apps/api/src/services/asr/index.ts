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
 * THE ONE CALL EVERYTHING ELSE SHOULD MAKE.
 *
 * Order set by `npm run asr:bench --workspace=@nukkad/api`, three trials per
 * engine on one Hinglish clip, scored not by word error rate but by how many
 * of the three spoken items reach the far end as the right SKU:
 *
 *   engine                   median   range        found
 *   whisper hi + romanise    1842ms   1515-2051    2/3
 *   shunya zero-indic en      488ms    382-1547    2/3
 *   sarvam saaras translit    514ms    414-638     3/3
 *
 * Sarvam leads, and the reason is narrower than the table looks. All three
 * land tel and chai patti. Only Sarvam hears ATTA -- Whisper writes "adaa",
 * Shunya writes "Aa", and neither survives ranking. One word decides it,
 * which is exactly what you would expect when the catalogue constraint is
 * already rescuing everything that is merely misspelt.
 *
 * WER would have ranked these differently and wrongly. Shunya's transcript
 * is the least faithful of the three as prose and still ties Whisper on the
 * only measure that pays.
 *
 * Each returns null rather than throwing, so the chain degrades instead of
 * failing: Sarvam, then Shunya, then Whisper, which needs no key beyond the
 * Groq one the rest of the system already has.
 *
 * A NOTE ON THE CLIP. It is a Windows speech synthesiser reading Hinglish in
 * a US English voice, which is the one input the Indic models are NOT tuned
 * for and Whisper is. That biases the table TOWARDS Whisper, and Whisper
 * still comes last on both axes. A recording of an actual person would widen
 * the gap, not close it -- but it has not been run, so treat the exact
 * milliseconds as indicative and the ORDER as the finding.
 */
export async function transcribe(path: string, fast = false): Promise<Transcription> {
  return (
    (await transcribeSarvam(path)) ??
    (await transcribeShunya(path)) ??
    (await transcribeGroq(path, fast))
  );
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
 * Sarvam saaras, the primary engine. See `transcribe` above for why.
 *
 * Single-legged auth, unlike Shunya: the subscription key goes straight on
 * the request, so there is no token to cache and no cold call to apologise
 * for. Still returns null on any failure, because being first in the chain
 * is not the same as being required.
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

  // Under SARVAM_MODE=translit this is already Roman and `romanise` is a
  // no-op. The check stays because mode is configuration, and configuration
  // drifts; codemix would put Devanagari here and the resolver cannot tell
  // the difference between that and an empty query.
  return {
    text: isRoman(raw) ? raw : await romanise(raw),
    raw,
    engine: `${env.SARVAM_MODEL}:${env.SARVAM_MODE}`,
    latencyMs: Date.now() - t0,
  };
}
