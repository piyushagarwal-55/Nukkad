import { speak } from './tts.js';

/**
 * SPEAK IN SENTENCES, NOT IN REPLIES.
 *
 * Synthesising a whole reply before playing any of it means the customer
 * hears nothing for as long as the longest sentence takes -- measured at
 * 3964ms on a three-clause answer, which on a phone is indistinguishable
 * from a dropped line.
 *
 * The fix is the one the interview agent in practers uses: cut the text
 * at sentence boundaries and fire TTS per sentence, chained so they play
 * in order while later ones are still being made. First sound arrives
 * after the FIRST sentence, and the rest streams in behind it. Total time
 * barely moves; time-to-first-sound collapses, and that is the number a
 * caller actually experiences.
 *
 * WHAT IS DIFFERENT HERE, and it is not cosmetic. That pipeline streams
 * its LLM and chunks the token stream. Ours cannot: the composer runs in
 * JSON mode, so a partial response is partial JSON rather than partial
 * prose. It is also not worth it -- compose is 428ms warm against 4000ms
 * of speech, so the whole prize is in the mouth, not the brain.
 *
 * AND EVERY CHUNK IS STILL CHECKED. compose() validates its output before
 * returning it -- no fabricated totals, no invented quantities -- and
 * speaking a sentence at a time must not become a way around that. The
 * caller passes the same guard, applied per chunk, so an unsafe sentence
 * is dropped before it is ever heard rather than after.
 */

/**
 * Cut at sentence boundaries, keeping everything.
 *
 * A boundary is .!? followed by whitespace or the end. `[\s\S]*?` eats
 * everything up to it, so a dot inside a decimal or an abbreviation --
 * "Rs 351.53" -- is not a boundary, because it has no space after it.
 * Text before such a dot is never dropped; it stays in the chunk that
 * ends at the next real boundary.
 */
export function extractSpeechChunks(buffer: string): { chunks: string[]; remaining: string } {
  const chunks: string[] = [];
  let lastIndex = 0;

  const regex = /[\s\S]*?[.!?]+(?:\s|$)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(buffer)) !== null) {
    const sentence = match[0].trim();
    if (sentence) chunks.push(sentence);
    lastIndex = regex.lastIndex;
  }

  return { chunks, remaining: buffer.slice(lastIndex) };
}

/**
 * A very short fragment is not worth a round trip of its own.
 *
 * "Ji." on its own costs a whole TTS call to say almost nothing, and the
 * gap before the next sentence is longer than the sound. Below this it is
 * merged forward into the sentence after it.
 */
const MIN_CHUNK = 12;

export function sentences(text: string): string[] {
  const { chunks, remaining } = extractSpeechChunks(text);
  const all = remaining.trim() ? [...chunks, remaining.trim()] : chunks;

  const out: string[] = [];
  for (const c of all) {
    const prev = out[out.length - 1];
    if (prev && prev.length < MIN_CHUNK) out[out.length - 1] = `${prev} ${c}`;
    else out.push(c);
  }
  return out.length ? out : [text.trim()].filter(Boolean);
}

export interface SpokenChunk {
  index: number;
  text: string;
  audio: Buffer;
  ms: number;
}

/**
 * Speak `text` sentence by sentence, handing each back the moment it is
 * ready. The caller decides what to do with them -- a browser queues
 * them for playback, a phone writes them to the call.
 *
 * ABORTABLE AT EVERY BOUNDARY, because barge-in is the whole reason a
 * voice agent feels alive. When the customer starts talking over the
 * shop, the signal fires and the remaining sentences are never made,
 * never mind spoken. Checked before each synthesis AND after, since a
 * request already in flight can finish after the interruption.
 */
export async function speakInChunks(
  text: string,
  onChunk: (c: SpokenChunk) => void | Promise<void>,
  opts: { signal?: AbortSignal; allow?: (chunk: string) => boolean } = {},
): Promise<{ chunks: number; firstMs: number; totalMs: number }> {
  const started = Date.now();
  let firstMs = 0;
  let index = 0;

  for (const chunk of sentences(text)) {
    if (opts.signal?.aborted) break;
    if (opts.allow && !opts.allow(chunk)) continue;

    const t0 = Date.now();
    const said = await speak(chunk);
    if (opts.signal?.aborted || !said) continue;

    if (!firstMs) firstMs = Date.now() - started;
    await onChunk({ index: index++, text: chunk, audio: said.audio, ms: Date.now() - t0 });
  }

  return { chunks: index, firstMs, totalMs: Date.now() - started };
}
