import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { groq } from '../../lib/groq.js';
import { env } from '../../config/env.js';
import { z } from 'zod';

/**
 * Supplier bill to structured line items.
 *
 * MODEL CHOICE, measured rather than assumed. An earlier note here claimed
 * qwen3.6 was the more faithful reader, and it was the primary for that
 * reason. Once the prompt grew past about twenty lines -- docType, pack,
 * MRP, list price, discount, tax, free items -- 3.6 began failing Groq's
 * guided JSON decoder on EVERY call, and without guiding it returned
 * prose that would not parse at all. Every bill was therefore burning a
 * five second failure before the retry rescued it on 3.8.
 *
 * Measured on the same GST invoice: 3.6 guided fails in 4.8s and
 * unguided produces nothing parseable; 3.8 succeeds either way in 1.4s
 * with all three lines correct. So 3.8 is primary and 3.6 is the retry --
 * a second opinion is only worth having from a DIFFERENT model.
 *
 * Money is parsed straight to INTEGER PAISE. Asking the model for paise
 * rather than rupees removes a whole class of float rounding bugs, and it
 * matches Razorpay's own unit so nothing converts at the boundary.
 */
const billSchema = z.object({
  /**
   * Which way the stock moves.
   *
   * PURCHASE is a distributor billing the shop: stock comes IN. RETAIL is
   * the shop billing a customer: stock goes OUT. The two look similar on
   * paper and mean opposite things, and applying one as the other inflates
   * the catalogue by exactly what just left the shelf.
   */
  docType: z.enum(['PURCHASE', 'RETAIL', 'UNKNOWN']).default('UNKNOWN'),
  supplier: z.string().nullable().default(null),
  billNo: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
  items: z.array(z.object({
    name: z.string(),
    /** verbatim quantity text: "90kg", "200pcs", "8 peti". Parsed later. */
    qtyText: z.string().nullable().default(null),
    /** the Pack column, where the bill keeps size separate from name */
    pack: z.string().nullable().default(null),
    /**
     * Printed MRP, kept SEPARATE from the price actually charged.
     *
     * Retail bills discount off MRP -- 195.00 printed, 175.00 paid -- so
     * folding MRP into ratePaise makes qty x rate disagree with amount on
     * every discounted line and disputes the whole bill. It is worth having
     * on its own: MRP is a sound default selling price.
     */
    mrpPaise: z.number().int().nonnegative().nullable().default(null),
    /**
     * A proper GST tax invoice prices a line in four moves, not one:
     *
     *     amount = qty x listPrice x (1 - disc%) x (1 + tax%)
     *
     * On a real invoice all three of these columns are populated and NONE
     * of them equals the amount divided by quantity. Comparing qty x list
     * to the amount disputes every single line of a perfectly good bill,
     * so each part is captured and the whole equation is checked.
     */
    listPricePaise: z.number().int().nonnegative().nullable().default(null),
    discPct: z.number().nonnegative().max(100).nullable().default(null),
    taxPct: z.number().nonnegative().max(50).nullable().default(null),
    /** quantity present, amount absent: a free item. Never priced. */
    free: z.boolean().default(false),
    qty: z.number().positive(),
    /**
     * NULLABLE, and this matters more than it looks.
     *
     * Plenty of real wholesale books fill in only Quantity and Amount and
     * leave the Rate column blank; the shopkeeper does the division in his
     * head. Requiring a number here made the model choose between lying and
     * failing validation, and it correctly chose to fail: an entire
     * Devanagari bill was thrown away because eleven rate cells were empty.
     *
     * A missing field is information. The repair node derives it.
     */
    ratePaise: z.number().int().nonnegative().nullable().default(null),
    amountPaise: z.number().int().nonnegative().nullable().default(null),
  })),
  totalPaise: z.number().int().nonnegative().nullable().default(null),
});

export type ParsedBill = z.infer<typeof billSchema>;

export const PROMPT = [
  'This is a wholesale supplier bill for an Indian kirana shop.',
  'Extract every line item. Return ONLY JSON:',
  '{"supplier":"","billNo":"","date":"","items":[{"name":"",',
  '"qtyText":"","qty":<number>,"ratePaise":<int|null>,',
  '"amountPaise":<int|null>}],"totalPaise":<int|null>}',
  'RULES:',
  '- Money must be INTEGER PAISE. 255.00 rupees is 25500.',
  '- Copy item names VERBATIM, including brand and pack size. Do not tidy them.',
  '- Skip tax rows, discount rows and the grand total from the items array.',
  '- If a column is BLANK on the bill, or a value is unreadable, use null.',
  '  Do NOT compute it, do NOT estimate it. A blank Rate column is normal in',
  '  Indian wholesale books and null is the correct answer for it.',
  '- qtyText: copy the quantity cell verbatim, units and all: "90kg",',
  '  "200pcs", "8 peti". qty is just the number from it.',
  '- The bill may be handwritten, in Hindi/Devanagari, or a mix. Copy names',
  '  in their ORIGINAL script. Do not translate or transliterate them.',
  '- Always read the printed grand total into totalPaise if one is shown.',
  '- docType: RETAIL if this is a shop billing a CUSTOMER (look for',
  '  \"Retail Invoice\", a cash/customer name, \"thanks visit again\",',
  '  \"you have saved\", an MRP column). PURCHASE if a distributor or',
  '  wholesaler is billing the shop. UNKNOWN if genuinely unclear.',
  '- pack: the Pack/Size column if the bill has one (\"5KG\", \"150G\",',
  '  \"1 LT\"). Do NOT merge it into name.',
  '- MRP and RATE are DIFFERENT columns. MRP is the printed maximum price;',
  '  ratePaise is what was actually charged per unit. If a bill shows only',
  '  MRP and AMOUNT, put MRP in mrpPaise and leave ratePaise null.',
  '- A GST tax invoice has List Price, Disc. and Tax % columns. Read each',
  '  into listPricePaise, discPct and taxPct. Do NOT put List Price into',
  '  ratePaise: on such a bill the amount already includes tax and discount,',
  '  so they are different numbers.',
  '- discPct and taxPct are PERCENTAGES, not amounts. \"5.00 (%)\" is 5.',
  '- free: true for an item under a \"Free Items\" heading, or any line with',
  '  a quantity but no amount. Leave its amountPaise null.',
].join('\n');

/**
 * Groq bills vision by input size, and the account here is on 8000 tokens
 * per MINUTE. A 1357x1920 phone photo of an invoice costs about 3210 of
 * them, so three bills in a minute is a 429 and a demo that stalls for
 * thirty seconds.
 *
 * Capping the long edge cuts that materially. Measured on the same
 * invoice: 1357x1920 and 777x1100 both return three lines with the total
 * read correctly, in 1409ms and 1286ms. The pixels above this cap were
 * paying rent and doing nothing.
 */
const MAX_EDGE = 1100;

async function prepare(path: string): Promise<{ b64: string; mime: string }> {
  const raw = await readFile(path);
  try {
    const meta = await sharp(raw, { failOn: 'none' }).metadata();
    const edge = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (!edge || edge <= MAX_EDGE) {
      return { b64: raw.toString('base64'), mime: mimeOf(meta.format) };
    }

    /**
     * JPEG out, not PNG. A phone photo re-encoded losslessly grows: this
     * invoice went 85KB to 291KB as a PNG for no gain, since the token cost
     * follows the pixel dimensions and the extra bytes only slow the upload.
     * Quality 88 is indistinguishable on printed text.
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

function mimeOf(format?: string): string {
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

/** A rate limit is not a reading failure and must not be treated as one. */
export class RateLimited extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('rate limited');
  }
}

export interface ParseResult {
  bill: ParsedBill;
  model: string;
  latencyMs: number;
}

export async function parseBill(imagePath: string, mime: string, fast = false): Promise<ParseResult> {
  const model = fast ? (env.GROQ_VISION_MODEL_FAST ?? env.GROQ_VISION_MODEL!) : env.GROQ_VISION_MODEL!;
  if (!model) throw new Error('GROQ_VISION_MODEL is not set');

  const { b64, mime: sendMime } = await prepare(imagePath);
  const t0 = Date.now();

  let res;
  try {
    res = await groq.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:${sendMime};base64,${b64}` } },
      ],
    }],
    });
  } catch (err) {
    /**
     * Separate a rate limit from a bad read.
     *
     * They arrive as the same rejected promise and mean opposite things. A
     * 429 says the account is out of tokens this minute; the model was
     * never asked and has done nothing wrong. Falling back to a weaker
     * model there is the wrong answer to the wrong question, and it showed:
     * a rate-limited run demoted itself to qwen3.6, which then read one
     * line of a three line bill.
     */
    const e = err as { status?: number; message?: string };
    if (e.status === 429) {
      const m = /try again in ([\d.]+)s/i.exec(e.message ?? '');
      throw new RateLimited(Math.ceil((m ? Number(m[1]) : 3) * 1000) + 250);
    }
    throw err;
  }

  const raw = res.choices[0]?.message?.content ?? '{}';

  /**
   * Take the first {...} block rather than trusting the whole response.
   *
   * Guided decoding usually returns bare JSON, but a model that ignores it
   * wraps the object in a code fence or a sentence of preamble, and
   * JSON.parse then throws on a response that was actually fine. zod is
   * still the real gate; this only finds the object to hand it.
   */
  const block = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
  let json: unknown;
  try {
    json = JSON.parse(block);
  } catch {
    throw new Error('model did not return JSON: ' + raw.slice(0, 120));
  }

  const parsed = billSchema.safeParse(json);
  if (!parsed.success) throw new Error('bill did not match schema: ' + parsed.error.message);

  return { bill: parsed.data, model, latencyMs: Date.now() - t0 };
}
