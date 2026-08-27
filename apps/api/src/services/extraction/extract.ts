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
  '"intent":"ORDER|REPEAT|ACCOUNT|CANCEL|MODIFY|CONFIRM|REJECT|GREETING|QUESTION|UNKNOWN",',
  '"goal":"ORDERING|RECOMMENDATION|QA|SEARCH|META"}',
  'RULES:',
  '- Copy the product span VERBATIM from the input. Do not translate it,',
  '  do not normalise spelling, do not guess or add a brand.',
  '- You do NOT pick products from any catalogue. Something downstream does that.',
  '- Convert Hinglish number words to digits: do=2, teen=3, chaar=4, paanch=5,',
  '  das=10, adha=0.5, dedh=1.5, dhai=2.5, sava=1.25.',
  '- If the message is not an order, return items:[] and the right intent.',
  'INTENT NOTES:',
  '- REPEAT: wants the previous order again. "wahi wala bhej do",',
  '  "pichhli baar wala", "same as last time". Return items:[] for these,',
  '  the previous order is looked up downstream.',
  '- ACCOUNT: asking about their own spending or order history.',
  '  "kitna hua", "mera hisaab", "how much do I owe".',
  '- GREETING: hello, namaste, kya haal hai, thanks, ok.',
  '- QUESTION: asking the SHOP something. Timings, whether something is in',
  '  stock, what a price is. Still return any product span in items so the',
  '  question can be answered about the right thing.',
  '- REJECT: saying no to something the SHOP just offered. "ye nahi",',
  '  "dusra dikhao", "isko hata do". NOT the same as CANCEL, which ends',
  '  the whole order.',
  'GOAL -- what the message is IN SERVICE OF, a separate question:',
  '- ORDERING: getting specific goods bought. The common case by far.',
  '- RECOMMENDATION: they have not decided and want the shop to suggest.',
  '  "kuch acha sa tel batao", "kya lena chahiye".',
  '- QA: a short factual question. Price, in stock or not, pack size.',
  '- SEARCH: a why/how question, or one needing several turns to answer.',
  '- META: greetings, thanks, chit-chat. Nothing to do with goods.',
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
  if (!parsed.success) return { items: [], intent: 'UNKNOWN', goal: 'ORDERING' };
  return parsed.data;
}
