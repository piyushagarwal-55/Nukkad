import { groq } from '../../lib/groq.js';
import { env } from '../../config/env.js';
import { extractionSchema, type Extraction } from '@nukkad/shared';

/**
 * The model SEGMENTS and pulls quantities. It does NOT pick the SKU.
 *
 * This split is the whole design. Letting a language model name the
 * product is the failure mode that caps open-menu voice ordering around
 * 86 percent even in clean English. SKU choice belongs to the ranker,
 * which is constrained to this shop's catalogue and conditioned on the
 * household's own reorder history.
 *
 * Verified against real Hinglish on 26 Aug. Notably 'wo peela wala tel'
 * survives as a verbatim span, which no transcriber can resolve and the
 * ranker can.
 */
const SYSTEM = [
  'You segment Indian grocery orders. Return ONLY JSON matching:',
  '{"items":[{"text":"<verbatim span naming the product>","quantity":<number>,"unit":"<unit or null>"}],',
  '"intent":"ORDER|CANCEL|MODIFY|QUESTION|CONFIRM|UNKNOWN"}',
  'RULES:',
  '- Copy the product span VERBATIM from the input. Do not translate it,',
  '  do not normalise spelling, do not guess or add a brand.',
  '- You do NOT pick products from any catalogue. Something downstream does that.',
  '- Convert Hinglish number words to digits: do=2, teen=3, chaar=4, paanch=5,',
  '  das=10, adha=0.5, dedh=1.5, dhai=2.5, sava=1.25.',
  '- If the message is not an order, return items:[] and the right intent.',
].join('\n');

export async function extractOrder(text: string, fast = false): Promise<Extraction> {
  const res = await groq.chat.completions.create({
    model: fast ? env.GROQ_LLM_MODEL_FAST : env.GROQ_LLM_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: text },
    ],
  });

  const raw = res.choices[0]?.message?.content ?? '{}';
  const parsed = extractionSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return { items: [], intent: 'UNKNOWN' };
  return parsed.data;
}
