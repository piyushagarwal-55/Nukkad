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
  '"productSource":"EXPLICIT|LAST_NAMED|NONE",',
  '"intent":"ORDER|REPEAT|ACCOUNT|CANCEL|MODIFY|CONFIRM|CHECKOUT|REJECT|GREETING|QUESTION|UNKNOWN",',
  '"goal":"ORDERING|RECOMMENDATION|QA|SEARCH|META"}',
  'RULES:',
  '- Copy the product span VERBATIM from the input. Do not translate it,',
  '  do not normalise spelling, do not guess or add a brand.',
  '- You do NOT pick products from any catalogue. Something downstream does that.',
  '- Convert Hinglish number words to digits: do=2, teen=3, chaar=4, paanch=5,',
  '  das=10, adha=0.5, dedh=1.5, dhai=2.5, sava=1.25.',
  '- If the message is not an order, return items:[] and the right intent.',
  'WHERE THE PRODUCT IS, which is why you see the recent messages:',
  '- EXPLICIT: they named it in THIS message. Put the span in items.',
  '- LAST_NAMED: they pointed at what was just discussed instead of',
  '  naming it -- "yeh bhi daal do", "haan daal do", "ek aur", "same',
  '  wala", "wo hi bhej do". Return items:[]; something downstream knows',
  '  which product that was. Use this ONLY if the recent messages show a',
  '  product to point at.',
  '- NONE: no product is involved. A greeting, a question about timings.',
  '- Hinglish puts commands where products look like they should be.',
  '  "daal do" is PUT IT IN, not lentils. "de do", "kar do", "bhej do",',
  '  "hata do" are all instructions. Never return one as a product span.',
  '  "ek kilo daal do" with no earlier product IS lentils; the same words',
  '  right after the shop quoted a price are not.',
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
  '- CHECKOUT: they are finished adding and want the order sent. "bas",',
  '  "itna hi", "ho gaya", "bhej do" ON ITS OWN, "that is all". If the',
  '  message ALSO names a product it is ORDER, not CHECKOUT -- "do kilo',
  '  atta bhej do" is an order, plain "bhej do" is a checkout.',
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

/** the shop's side and the customer's, most recent last */
export interface Turn { role: 'user' | 'shop'; text: string }

/**
 * @param recent the last few turns, so the parser can see what "yeh"
 *        points at. Optional: the eval harness and the ASR bench call
 *        this on isolated sentences with no conversation at all, and
 *        must keep behaving exactly as they did.
 */
export async function extractOrder(
  text: string,
  fast = false,
  recent: Turn[] = [],
): Promise<Extraction> {
  /**
   * THE PARSER GETS THE CONVERSATION, which it never used to.
   *
   * The composer has always been shown the last several turns -- that is
   * what stops it repeating itself -- while the parser saw one message in
   * isolation. So the PROSE had context and the DECISIONS did not, and
   * every referent bug in this system came out of that one asymmetry:
   * "yeh" ranked as a product name and returned dry yeast, "daal do"
   * matched a lentil, "haan daal do" added Toor Dal to a customer who had
   * just been quoted the price of sugar.
   *
   * It still does not get to name a product. It reports that the
   * reference points backwards, and the state resolver supplies the SKU.
   */
  const history = recent
    .slice(-6)
    .map((t) => `${t.role === 'user' ? 'Customer' : 'Shop'}: ${t.text}`)
    .join('\n');

  const user = history
    ? `RECENT MESSAGES:\n${history}\n\nNOW: ${text}`
    : text;

  const res = await groq.chat.completions.create({
    model: fast ? env.GROQ_LLM_MODEL_FAST : env.GROQ_LLM_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
  });

  const raw = res.choices[0]?.message?.content ?? '{}';
  const parsed = extractionSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return { items: [], intent: 'UNKNOWN', goal: 'ORDERING', productSource: 'NONE' };
  }
  return parsed.data;
}
