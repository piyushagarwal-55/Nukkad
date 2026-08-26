import { readFile } from 'node:fs/promises';
import { groq } from '../../lib/groq.js';
import { env } from '../../config/env.js';
import { z } from 'zod';

/**
 * Supplier bill to structured line items.
 *
 * Verified 26 Aug against a 7-line wholesale bill: both Groq vision models
 * returned every item, quantity, rate and total correctly in about two
 * seconds. qwen3.6 is more faithful on verbatim names and allows 5 images
 * per request; qwen3.8 is roughly 25% faster with 3.
 *
 * Money is parsed straight to INTEGER PAISE. Asking the model for paise
 * rather than rupees removes a whole class of float rounding bugs, and it
 * matches Razorpay's own unit so nothing converts at the boundary.
 */
const billSchema = z.object({
  supplier: z.string().nullable().default(null),
  billNo: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
  items: z.array(z.object({
    name: z.string(),
    qty: z.number().positive(),
    ratePaise: z.number().int().nonnegative(),
    amountPaise: z.number().int().nonnegative(),
  })),
  totalPaise: z.number().int().nonnegative().nullable().default(null),
});

export type ParsedBill = z.infer<typeof billSchema>;

const PROMPT = [
  'This is a wholesale supplier bill for an Indian kirana shop.',
  'Extract every line item. Return ONLY JSON:',
  '{"supplier":"","billNo":"","date":"","items":[{"name":"","qty":<number>,',
  '"ratePaise":<int>,"amountPaise":<int>}],"totalPaise":<int>}',
  'RULES:',
  '- Money must be INTEGER PAISE. 255.00 rupees is 25500.',
  '- Copy item names VERBATIM, including brand and pack size. Do not tidy them.',
  '- Skip tax rows, discount rows and the grand total from the items array.',
  '- If a field is genuinely unreadable use null rather than guessing.',
].join('\n');

export interface ParseResult {
  bill: ParsedBill;
  model: string;
  latencyMs: number;
}

export async function parseBill(imagePath: string, mime: string, fast = false): Promise<ParseResult> {
  const model = fast ? (env.GROQ_VISION_MODEL_FAST ?? env.GROQ_VISION_MODEL!) : env.GROQ_VISION_MODEL!;
  if (!model) throw new Error('GROQ_VISION_MODEL is not set');

  const b64 = (await readFile(imagePath)).toString('base64');
  const t0 = Date.now();

  const res = await groq.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    }],
  });

  const raw = res.choices[0]?.message?.content ?? '{}';
  const parsed = billSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('bill did not match schema: ' + parsed.error.message);

  return { bill: parsed.data, model, latencyMs: Date.now() - t0 };
}
