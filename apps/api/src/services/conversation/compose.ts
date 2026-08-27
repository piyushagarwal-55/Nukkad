import { z } from 'zod';
import { groq } from '../../lib/groq.js';
import { env } from '../../config/env.js';
import type { Turn } from './state.js';

/**
 * THE VOICE OF THE SHOP.
 *
 * Everything the buyer reads is written here, by a model, in their own
 * register. Nothing else in the codebase holds a buyer-facing sentence any
 * more, and the numbered menu is gone.
 *
 * WHY, given that canned strings are cheaper and cannot hallucinate.
 *
 * Because a fixed reply for every branch IS an if/else bot, and it reads
 * like one from the first message. Sending "Namaste Ramesh. Kya karna hai?
 * 1 = Pichhla order dobara bhejo ..." to someone who typed "Hi" tells them
 * they are talking to a form. Worse, the same string comes back every time
 * anything unexpected happens, so the third time a customer goes off-script
 * they have read it three times and learned that going off-script is
 * pointless. That is the failure the whole product is supposed to avoid: a
 * kirana WhatsApp line works because a human is on the other end.
 *
 * THE DIVISION OF LABOUR IS THE POINT, AND IT DOES NOT MOVE.
 *
 * The model owns the TALKING. It does not own the DECIDING. It never picks
 * a product, never quotes a price, never computes a total, never says
 * whether something is in stock, and never states an order's status. All of
 * that arrives as `facts`, already decided by the ranker, the catalogue and
 * the database, and the money-bearing part is rendered by code and appended
 * verbatim -- see `card` below. The model writes the sentence around it.
 *
 * So this adds conversational range without adding a single new way to be
 * wrong about a number. If the call fails, `fallback` is used and the
 * conversation continues in a duller voice rather than stopping.
 */

/** one thing that is true, which the reply must be built out of */
export type Facts =
  | { kind: 'GREETING' }
  | { kind: 'ORDER_DRAFT'; substituted: string[] }
  | { kind: 'ORDER_AMENDED' }
  | { kind: 'ORDER_CONFIRMED'; ref: string }
  | { kind: 'ORDER_CANCELLED' }
  | { kind: 'ORDER_REPLACED' }
  | { kind: 'ASK_WHICH'; sourceText: string; options: string[] }
  | { kind: 'STILL_WAITING' }
  | { kind: 'NOT_UNDERSTOOD' }
  | { kind: 'ACCOUNT'; orders: number; spent: string }
  | { kind: 'NO_PREVIOUS_ORDER' }
  | { kind: 'QUESTION' }
  | { kind: 'STOCK_ANSWER'; name: string; inStock: boolean; price: string }
  | { kind: 'NOT_REGISTERED' }
  | { kind: 'NO_PHOTO' };

/**
 * What each fact means, in the imperative, because the model is being told
 * what to convey rather than what to say. Phrasing is its job.
 */
function brief(f: Facts): string {
  switch (f.kind) {
    case 'GREETING':
      return [
        'They said hello or made small talk. Greet them back warmly and',
        'briefly, and let them know they can just say what they need.',
        'Do NOT list options or menu numbers.',
      ].join(' ');

    case 'ORDER_DRAFT': {
      const sub = f.substituted.length
        ? ` NOTE: ${f.substituted.join(' and ')} was out of stock, so something else was put in its place -- say so plainly.`
        : '';
      return `Their order is ready to send. Ask if you should send it.${sub}`;
    }

    case 'ORDER_AMENDED':
      return 'They added to or changed the order. Acknowledge the change and ask if you should send it now.';

    case 'ORDER_CONFIRMED':
      return `The order is confirmed and going out. Reference ${f.ref}. Reassure them briefly.`;

    case 'ORDER_CANCELLED':
      return 'The order is cancelled. Say so without fuss and leave the door open.';

    case 'ORDER_REPLACED':
      return [
        'They want to change the order but it is not clear what to change.',
        'The old one is cancelled. Ask them to send the whole list again.',
      ].join(' ');

    case 'ASK_WHICH':
      return [
        `They said "${f.sourceText}" and the shop stocks more than one thing`,
        `that could be: ${f.options.join(', ')}.`,
        'Ask which one they want, naturally, the way a shopkeeper would.',
        'Name the options in your sentence. Do NOT number them.',
        'Do NOT say how much they asked for -- you were not told the',
        'quantity and guessing at one puts a wrong number in front of a',
        'customer. Copy the product names exactly, pack size included.',
      ].join(' ');

    case 'STILL_WAITING':
      return 'The order below has not been sent yet. Ask again whether to send it.';

    case 'NOT_UNDERSTOOD':
      return [
        'You could not work out what they want. Say so honestly and ask for',
        'the item and quantity. Do not guess at products.',
      ].join(' ');

    case 'ACCOUNT':
      return `They asked about their account: ${f.orders} orders so far, ${f.spent} in total. Tell them.`;

    case 'NO_PREVIOUS_ORDER':
      return 'They wanted their last order repeated but there is no previous order. Say so and ask what they need.';

    case 'STOCK_ANSWER':
      return f.inStock
        ? [
            `They asked about ${f.name}. It IS in stock at ${f.price}.`,
            'Tell them, and ask how much they want.',
          ].join(' ')
        : [
            `They asked about ${f.name}. It is OUT of stock right now.`,
            'Tell them plainly. Do not promise a date.',
          ].join(' ');

    case 'QUESTION':
      return [
        'They asked the shop something you do not have the answer to --',
        'timings, delivery, stock of something not in the catalogue, or',
        'anything else. Do NOT invent an answer, a time, a price or a',
        'policy. Say the shopkeeper will confirm, and offer to take their',
        'order meanwhile.',
      ].join(' ');

    case 'NOT_REGISTERED':
      return [
        'This number is not registered with any shop, so you cannot serve',
        'them. Tell them politely to ask their shopkeeper to add the number.',
      ].join(' ');

    case 'NO_PHOTO':
      return 'They sent a photo and photos cannot be read yet. Ask them to type it or send a voice note.';
  }
}

const SYSTEM = [
  'You are the person answering WhatsApp for a small neighbourhood kirana',
  'shop in India. You are not a bot and you do not sound like one.',
  '',
  'Return ONLY JSON: {"reply":"..."}',
  '',
  'HOW TO WRITE',
  '- Short. One or two sentences. This is WhatsApp, not email.',
  '- Warm and ordinary, the way a shopkeeper talks to a regular.',
  '- Mirror their language AND their script exactly. Roman Hinglish gets',
  '  Roman Hinglish. Devanagari gets Devanagari. English gets English.',
  '- Never use numbered menus, option lists, or "reply 1 for".',
  '- Do not repeat a sentence you have already sent them. The recent',
  '  messages are shown to you. Say it a different way, or say something',
  '  more useful.',
  '- No emoji unless they used one first.',
  '',
  'WHAT YOU MAY SAY',
  '- ONLY what the FACT below tells you. It is the entire truth you have.',
  '- Never invent or mention a product, price, total, stock level, delivery',
  '  time, shop timing or discount. If it is not in the FACT, you do not',
  '  know it, and saying the shopkeeper will confirm is always allowed.',
].join('\n');

/**
 * Appended to the prompt when a ledger will follow the reply.
 *
 * The model is NOT shown that ledger. Telling it "do not restate the
 * numbers" while showing it the numbers did not work: asked to confirm two
 * kilos of atta it wrote "Ji, 1 kilo atta bhej dena?", having read the item
 * COUNT as a quantity, and on another turn it lifted the 5kg out of the
 * pack name. An instruction not to use information it can see is a request.
 * Not giving it the information is a guarantee.
 *
 * So the invariant is sharp and easy to check: when a ledger is attached,
 * the sentence above it contains no digits at all, and every number the
 * customer reads was computed in ./messages.ts.
 */
const NO_NUMBERS = [
  '',
  'A list of the items and the total is attached under your reply.',
  'You cannot see it and you do not need to.',
  'Write NO digits and NO quantities at all -- not how many items, not',
  'weights, not pack sizes, not prices. Say "ye" or "aapka order" and let',
  'the list speak for itself.',
].join('\n');

const schema = z.object({ reply: z.string().min(1).max(600) });

export interface ComposeInput {
  facts: Facts;
  /** what the buyer just sent, verbatim, so the register can be mirrored */
  said: string;
  buyerName: string;
  shopName: string;
  recent: Turn[];
  /** deterministic order lines and total, appended after the reply */
  card?: string;
  /** used verbatim if the model call fails */
  fallback: string;
}

/**
 * VALIDATE, DO NOT TRUST.
 *
 * Everything below exists because a prompt rule is a request. Told not to
 * restate the order, the model wrote its own imitation ledger above the
 * real one:
 *
 *     Aapka order ready hai, bhejne ka kaam shuru kar doon?
 *     Aapka order:
 *     - Arhar
 *     - Shakkar
 *     Total: ...
 *
 * followed by the actual list with the actual total. Two lists, one of
 * them fiction. No amount of asking more firmly fixes that class of thing,
 * so the output is checked against the rules and the deterministic
 * fallback is used when it breaks them. A duller sentence is a small cost;
 * a fabricated total is not.
 */

/** one line, no imitation ledgers */
function sanitise(raw: string): string {
  const firstLine = raw.trim().split('\n')[0]!.trim();
  // a bullet or a "Total:" is the model starting to draw a card
  return firstLine.split(/\btotal\s*:/i)[0]!.replace(/\s+/g, ' ').trim();
}

/**
 * Every digit-run the reply is permitted to contain, taken from the facts
 * it was given.
 *
 * A whitelist rather than a ban, because "India Gate Basmati Rice 5kg" is
 * a product name the shop must be able to say out loud, and its 5 is not
 * an invented quantity. What this catches is the 1 in "Ji, 1 kilo atta
 * bhej dena?" when the order was two kilos and no fact mentioned a one.
 */
function allowedDigits(f: Facts): Set<string> {
  const source: string[] = [];
  if (f.kind === 'ASK_WHICH') source.push(...f.options, f.sourceText);
  if (f.kind === 'STOCK_ANSWER') source.push(f.name, f.price);
  if (f.kind === 'ACCOUNT') source.push(String(f.orders), f.spent);
  if (f.kind === 'ORDER_CONFIRMED') source.push(f.ref);

  const out = new Set<string>();
  for (const s of source) for (const d of s.match(/\d+/g) ?? []) out.add(d);
  return out;
}

function violates(reply: string, allowed: Set<string>): boolean {
  if (/\btotal\b/i.test(reply)) return true;
  return (reply.match(/\d+/g) ?? []).some((d) => !allowed.has(d));
}

export async function compose(input: ComposeInput): Promise<string> {
  const history = input.recent
    .slice(-6)
    .map((t) => `${t.role === 'user' ? input.buyerName : 'You'}: ${t.text}`)
    .join('\n');

  const user = [
    `SHOP: ${input.shopName}`,
    `CUSTOMER: ${input.buyerName}`,
    history ? `\nRECENT MESSAGES:\n${history}` : '',
    `\nTHEY JUST SENT: ${input.said || '(nothing)'}`,
    `\nFACT: ${brief(input.facts)}`,
    input.card ? NO_NUMBERS : '',
  ].filter(Boolean).join('\n');

  let reply = input.fallback;
  const allowed = allowedDigits(input.facts);

  try {
    const res = await groq.chat.completions.create({
      model: env.GROQ_LLM_MODEL_FAST,
      // Some warmth is the entire point, so this is not zero. It is also
      // not high: the model is choosing phrasing, not choosing facts.
      temperature: 0.6,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    });
    const parsed = schema.safeParse(JSON.parse(res.choices[0]?.message?.content ?? '{}'));
    if (parsed.success) {
      const clean = sanitise(parsed.data.reply);
      // the fallback stands if the model wrote something it must not
      if (clean && !violates(clean, allowed)) reply = clean;
    }
  } catch {
    // a duller sentence is fine; a dropped message is not
  }

  return input.card ? `${reply}\n\n${input.card}` : reply;
}
