import { z } from 'zod';
import { groq } from '../../lib/groq.js';
import { env } from '../../config/env.js';
import { prepare } from './image.js';

/**
 * READING A PHOTOGRAPHED SHOPPING LIST.
 *
 * This is the single most natural thing a customer can do on WhatsApp and
 * the line could not do it at all. A photo arrived, `handle` checked
 * whether vision was UNAVAILABLE, found that it was available, and then
 * did nothing with the image -- so the text stayed empty and the message
 * fell through to the empty-message path and got answered with a greeting.
 * Someone sent a picture of their grocery list and the shop said "kya haal
 * hai".
 *
 * WHY NOT THE BILL AGENT, which already reads pictures.
 *
 * Because a list is not a bill and the difference is not cosmetic. A bill
 * has rates, amounts, a total and GST, and the bill agent's whole job is
 * arithmetic reconciliation -- it exists to catch a supplier whose line
 * items do not sum to what they charged. A shopping list has none of that:
 * "Flour 5kg / Rice 5kg / Sugar 1kg" is a want, not a transaction. Running
 * it through the bill graph would produce a document with nine nodes of
 * reconciliation to do over zero rupees, and every one of its "the total
 * does not match" defences would be reasoning about numbers that were
 * never written down.
 *
 * So this asks for exactly what a list contains and nothing else, and
 * hands the result to the SAME ranker that text and voice go through. The
 * catalogue constraint does not care which sense the words arrived by.
 * That is the whole reason the resolver takes strings.
 */

const schema = z.object({
  /**
   * `isList` is a guard, not a formality. People send photos of all sorts
   * of things -- a bill, a broken packet, their child -- and a model asked
   * to extract groceries from a picture of a dog will find groceries in a
   * picture of a dog.
   */
  isList: z.boolean(),
  items: z.array(z.object({
    /** verbatim, as written on the paper */
    text: z.string().min(1).max(80),
    quantity: z.number().positive().default(1),
    unit: z.string().nullable().default(null),
  })).max(40),
});

export type ParsedList = z.infer<typeof schema>;

const PROMPT = [
  'This is a photo sent to a neighbourhood grocery shop in India.',
  'It is probably a handwritten or typed shopping list.',
  '',
  'Return ONLY JSON: {"isList":true|false,"items":[{"text":"...","quantity":1,"unit":null}]}',
  '',
  'isList is FALSE if the picture is anything else -- a bill or receipt, a',
  'product packet, a person, a screenshot. When false return items:[].',
  'Do not try to find groceries in a picture that has none.',
  '',
  'For each line of the list:',
  '- text: copy the item name VERBATIM as written. Do not translate it, do',
  '  not correct the spelling, do not add a brand that is not on the paper.',
  '  Something downstream matches it to this shop\'s catalogue.',
  '- quantity: the number written. Default 1 when nothing is written.',
  '- unit: kg, g, L, ml, packet, dozen, or null if not written.',
  '',
  'RULES:',
  '- Devanagari, Roman or a mix: copy the script as it appears.',
  '- A line that is crossed out is NOT wanted. Skip it.',
  '- Ignore prices if any are written. This is a list, not a bill.',
  '- Ignore headings, dates, names and phone numbers.',
  '- If a line is illegible, skip it rather than guessing at a product.',
].join('\n');

export interface ListResult {
  list: ParsedList;
  model: string;
  latencyMs: number;
}

export async function parseList(imagePath: string): Promise<ListResult> {
  const model = env.GROQ_VISION_MODEL;
  if (!model) throw new Error('GROQ_VISION_MODEL is not set');

  const { b64, mime } = await prepare(imagePath);
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

  const parsed = schema.safeParse(JSON.parse(res.choices[0]?.message?.content ?? '{}'));

  return {
    // a malformed reply is treated as "not a list", which routes the
    // customer to a human sentence rather than to an empty order
    list: parsed.success ? parsed.data : { isList: false, items: [] },
    model,
    latencyMs: Date.now() - t0,
  };
}
