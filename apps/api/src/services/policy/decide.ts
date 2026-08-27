import { z } from 'zod';
import { groq } from '../../lib/groq.js';
import { env } from '../../config/env.js';
import { maskActions } from '../resolver/action.js';

/**
 * THE POLICY MODEL. It decides what to DO, not what was said.
 *
 * The question every earlier version asked was "what product is in this
 * message", and it asked it of a classifier that could not see the
 * conversation. That is the wrong question and the wrong reader, and the
 * bugs followed from both:
 *
 *   "haan daal do"        -> Toor Dal added, to someone discussing sugar
 *   "1 kg yeh pack kr do" -> dry yeast, then a price repeated back
 *   "yeh bhi"             -> three products that had never been mentioned
 *
 * Every one of those is the same failure: a message with NO product in it
 * was sent to a product matcher, which duly found a product. Given the
 * catalogue and enough fuzziness, it always will.
 *
 * So the question is now "given this message and this state, what should
 * the shop do next", and the answer is one of a FIXED set of actions.
 * Nothing is searched until an action says a search is needed. "haan daal
 * do" returns ADD_FROM_STATE and the catalogue is never consulted, which
 * is the only way to be sure it cannot answer.
 *
 * WHAT THE MODEL STILL MAY NOT DO. It does not name a SKU. On the
 * explicit branch it hands back the customer's own words and the
 * catalogue-constrained ranker decides; on the state branch it hands back
 * nothing at all and the state resolver supplies the id. Letting a model
 * pick the product is the failure this whole system is built to avoid,
 * and moving it up a layer would not have made it safe.
 */

/**
 * The action space, closed on purpose.
 *
 * Split by WHERE the product comes from rather than folding that into a
 * separate field, because it makes the model's job one choice instead of
 * two and the pair is what the router needs anyway. A model asked "add,
 * and separately, from where" gets the second half wrong far more often
 * than one asked to pick between ADD_EXPLICIT_PRODUCT and ADD_FROM_STATE.
 */
export const ACTIONS = [
  /** they named something to add: "do kilo atta bhej do" */
  'ADD_EXPLICIT_PRODUCT',
  /** they said add it, about what was just discussed: "haan daal do" */
  'ADD_FROM_STATE',
  /** they named something to take out: "sugar hata do" */
  'REMOVE_EXPLICIT_PRODUCT',
  /** take out what was just discussed: "yeh nahi chahiye" */
  'REMOVE_FROM_STATE',
  /** what does it cost */
  'ANSWER_PRICE',
  /** do you have it */
  'ANSWER_STOCK',
  /** what do you have -- a listing, or the whole catalogue */
  'SEARCH_PRODUCT',
  /** yes, to the question the shop just asked */
  'CONFIRM_PENDING_ACTION',
  /** no, to the question the shop just asked */
  'REJECT_PENDING_ACTION',
  /** send the last order again */
  'REPEAT_LAST_ORDER',
  /** how much have I spent */
  'ACCOUNT_SUMMARY',
  /** done adding, send it */
  'CHECKOUT',
  /** throw the whole basket away */
  'CANCEL_ORDER',
  /** hello, thanks, chit-chat */
  'GREET',
  /** they referred to something and there is nothing to refer to */
  'CLARIFY',
  'NOT_UNDERSTOOD',
] as const;

export type PolicyAction = (typeof ACTIONS)[number];

const schema = z.object({
  action: z.enum(ACTIONS),
  /**
   * The customer's OWN WORDS for each product, verbatim, and only on the
   * EXPLICIT branches. Never a SKU name, never corrected spelling -- the
   * ranker wants what they actually said.
   *
   * A LIST, because one message routinely names several things. Holding
   * a single query dropped the chini out of "do kilo atta aur ek kilo
   * chini bhej do" and put one item in a two-item order.
   */
  products: z.array(z.object({
    query: z.string().min(1),
    quantity: z.number().positive().default(1),
    unit: z.string().nullable().default(null),
  })).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type Decision = z.infer<typeof schema>;

/** what the shop knows right now, as the model sees it */
export interface PolicyState {
  /** the product the conversation is currently about, if any */
  lastNamed: string | null;
  /** the question the shop is waiting on an answer to, if any */
  pendingQuestion: string | null;
  /** what is already in the basket */
  basket: string[];
}

const SYSTEM = [
  'You are the decision layer of a WhatsApp ordering line for an Indian',
  'kirana shop. You do NOT talk to the customer and you do NOT choose',
  'products. You choose what the shop should DO next.',
  '',
  'Return ONLY JSON:',
  '{"action":"<one of the listed actions>",',
  '"products":[{"query":"<their words>","quantity":1,"unit":"kg|g|L|null"}],',
  '"confidence":0.0}',
  '',
  'ACTIONS:',
  ...ACTIONS.map((a) => `- ${a}`),
  '',
  'THE ONE DISTINCTION THAT MATTERS: EXPLICIT vs FROM_STATE.',
  '- EXPLICIT means the product is named in THIS message. Put EVERY',
  "  product they named into products, using the customer's own words --",
  '  verbatim, uncorrected, no brand you added yourself. "do kilo atta',
  '  aur ek kilo chini" is TWO entries, not one.',
  '- FROM_STATE means they referred to something already discussed',
  '  instead of naming it. products MUST be empty. Only use this when',
  '  the state below actually has a lastNamed to refer to.',
  '',
  'HINGLISH TRAPS, which is most of why you exist:',
  '- "daal do", "de do", "kar do", "rakh do" all mean PUT IT IN. They are',
  '  commands. "daal" here is NOT the lentil.',
  '- "ek kilo daal do" with a product already under discussion means a',
  '  kilo OF THAT. With no such product it means a kilo of lentils.',
  '- "haan daal do", "kar do", "theek hai bhej do" name no product at all.',
  '- "yeh", "wo", "same wala", "ek aur" all point backwards.',
  '- A quantity on its own -- "2 kg", "do packet" -- answers a question',
  '  the shop asked and refers to whatever it asked about.',
  '- "wahi wala order", "pichhla order dobara", "same as last time" mean',
  '  the whole PREVIOUS ORDER, which is REPEAT_LAST_ORDER -- not a',
  '  pointer to one product and not a search.',
  '- "bas", "itna hi", "ho gaya", "bhej do" on its own is CHECKOUT.',
  '',
  'RULES:',
  '- Never invent a product that is not in the message or the state.',
  '- products is empty for every FROM_STATE and non-product action.',
  '- If they refer backwards and lastNamed is empty, use CLARIFY.',
  '- confidence is how sure you are. Below 0.5 the shop will ask instead',
  '  of acting, so a low number is safer than a wrong action.',
].join('\n');

export interface PolicyInput {
  message: string;
  /** most recent last */
  recent: Array<{ role: 'user' | 'shop'; text: string }>;
  state: PolicyState;
}

/**
 * Decide, and fail towards asking.
 *
 * A failed call returns NOT_UNDERSTOOD at zero confidence rather than
 * throwing, because the caller's fallback -- ask the customer -- is
 * always a safe thing to do and never the wrong shape of reply.
 */
export async function decide(input: PolicyInput): Promise<Decision> {
  const history = input.recent
    .slice(-5)
    .map((t) => `${t.role === 'user' ? 'Customer' : 'Shop'}: ${t.text}`)
    .join('\n');

  /**
   * The structured state matters more than the transcript, so it goes
   * last and it goes in as data rather than prose. A model reading five
   * messages has to infer what the conversation is about; a model handed
   * lastNamed does not.
   */
  const user = [
    `MESSAGE: ${input.message}`,
    history ? `\nRECENT:\n${history}` : '',
    '\nSTATE:',
    `  lastNamed: ${input.state.lastNamed ?? 'none'}`,
    `  shopIsWaitingOn: ${input.state.pendingQuestion ?? 'nothing'}`,
    `  basket: ${input.state.basket.length ? input.state.basket.join(', ') : 'empty'}`,
  ].filter(Boolean).join('\n');

  try {
    const res = await groq.chat.completions.create({
      model: env.GROQ_LLM_MODEL,
      // a router, not a writer: no room for invention
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    });

    const parsed = schema.safeParse(JSON.parse(res.choices[0]?.message?.content ?? '{}'));
    if (!parsed.success) return LOST;

    return validate(parsed.data, input);
  } catch {
    return LOST;
  }
}

const LOST: Decision = {
  action: 'NOT_UNDERSTOOD', products: [], confidence: 0,
};

/**
 * THE VALIDATOR. The model proposes, this disposes.
 *
 * Everything here is a rule the model was told and might not follow, and
 * each one has a cost if it does not. None of them are style.
 */
function validate(d: Decision, input: PolicyInput): Decision {
  const explicit = d.action.endsWith('EXPLICIT_PRODUCT');

  /**
   * Referring to nothing. The model was told to use CLARIFY here, and
   * when it does not, acting on an empty referent means acting on
   * whatever the catalogue happens to return.
   */
  if (d.action.endsWith('FROM_STATE') && !input.state.lastNamed) {
    return { ...d, action: 'CLARIFY', products: [] };
  }

  if (!explicit) return { ...d, products: [] };

  /**
   * COMMAND WORDS GO NO FURTHER, whatever the model was told.
   *
   * A query that masks down to nothing was a command all along -- "daal
   * do" reaching the matcher is the original bug in this whole thread.
   * Checked here rather than trusted to the instruction, because the mask
   * is deterministic and an instruction is a request.
   */
  const cleaned = d.products
    .map((p) => ({ ...p, query: maskActions(p.query).rest.trim() }))
    .filter((p) => p.query.length > 0);

  if (!cleaned.length) {
    return input.state.lastNamed
      ? {
          ...d,
          action: d.action.startsWith('ADD') ? 'ADD_FROM_STATE' : 'REMOVE_FROM_STATE',
          products: [],
        }
      : { ...d, action: 'CLARIFY', products: [] };
  }

  return { ...d, products: cleaned };
}
