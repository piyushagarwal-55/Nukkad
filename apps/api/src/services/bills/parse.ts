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

const PROMPT = [
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
