import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

/**
 * Getting a photo ready for a vision model. Shared, because there are now
 * two things that read pictures -- the bill agent and the WhatsApp line --
 * and they must agree about resolution or one of them is being measured on
 * a different input than the other.
 *
 * WHY THERE IS A CAP AT ALL. Token cost and latency follow pixel
 * dimensions, and a modern phone camera hands you 4000px of mostly paper.
 * Measured on the same invoice: 1357x1920 and 777x1100 both return three
 * lines with the total read correctly, in 1409ms and 1286ms. The pixels
 * above the cap were paying rent and doing nothing.
 */
const MAX_EDGE = 1100;

export function mimeOf(format?: string): string {
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

export async function prepare(path: string): Promise<{ b64: string; mime: string }> {
  const raw = await readFile(path);
  try {
    const meta = await sharp(raw, { failOn: 'none' }).metadata();
    const edge = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (!edge || edge <= MAX_EDGE) {
      return { b64: raw.toString('base64'), mime: mimeOf(meta.format) };
    }

    /**
     * JPEG out, not PNG. A phone photo re-encoded losslessly GROWS: one
     * invoice went 85KB to 291KB as a PNG for no gain, since the token cost
     * follows the pixel dimensions and the extra bytes only slow the
     * upload. Quality 88 is indistinguishable on printed text.
     */
    const out = await sharp(raw, { failOn: 'none' })
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { b64: out.toString('base64'), mime: 'image/jpeg' };
  } catch {
    // an exotic format sharp cannot open still deserves a read attempt
    return { b64: raw.toString('base64'), mime: 'image/png' };
  }
}

/** A rate limit is not a reading failure and must not be treated as one. */
export class RateLimited extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('rate limited');
  }
}
