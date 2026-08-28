import { z } from 'zod';
import { groq } from '../../lib/groq.js';
import { env } from '../../config/env.js';
import type { Turn } from './state.js';
import { direct, deliveryBrief } from './director.js';

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

/**
 * A stock-out and what was put in its place, with the REASON.
 *
 * The reason is here because of the most quietly useful number in
 * MG-ShopDial: Explain accounts for 22.7% of real utterances, nearly a
 * quarter of everything said, and this shop did none of it. It marked a
 * swapped line "(badla gaya)" and left the customer to work out why their
 * Fortune had become Dhara. A shopkeeper handing over a different bottle
 * says why in the same breath, every single time.
 */
export interface Swap {
  from: string;
  to: string;
  /** already phrased as a justification, e.g. "same daam" */
  why: string;
}

/**
 * A requested amount that does not divide into whole packets.
 *
 * Two kilos of atta from a shop selling five-kilo bags is not an order,
 * it is a question -- and it is the question a customer asked for by name:
 * do not quietly hand them a different size, say what you have and let
 * them decide. Same rule the ranker follows for an uncertain product,
 * applied to an uncertain amount.
 */
export interface PackAsk {
  /** "2 kg" */
  asked: string;
  /** "5 kg" */
  sold: string;
  name: string;
  /** how many packets went on the card, rounded up */
  units: number;
}

/** one thing that is true, which the reply must be built out of */
export type Facts =
  | { kind: 'GREETING' }
  | { kind: 'ORDER_DRAFT'; substituted: Swap[]; packAsks: PackAsk[]; dropped: string[] }
  /**
   * Something went IN THE BAG and the conversation carries on.
   *
   * The counterpart to the basket in state.ts. Every add used to be a
   * checkout -- "bhej dun?" after each item -- which is not how a counter
   * works. Now the shop says what went in and asks what else, and the
   * bill is added up once at the end.
   */
  | {
      kind: 'BASKET_ADDED';
      added: string[];
      substituted: Swap[];
      packAsks: PackAsk[];
      dropped: string[];
    }
  /** the basket read back, waiting on a yes */
  | { kind: 'BASKET_REVIEW' }
  /** they said send it and there is nothing in the bag */
  | { kind: 'BASKET_EMPTY' }
  | { kind: 'ORDER_AMENDED' }
  | { kind: 'ORDER_CONFIRMED'; ref: string }
  /**
   * Checked out, link sent, waiting on money. NOT confirmed -- the goods
   * have not moved and will not until Razorpay says so.
   */
  | { kind: 'AWAITING_PAYMENT'; ref: string; link: string | null }
  /** they asked about a payment and Razorpay has not seen it */
  | { kind: 'PAYMENT_NOT_SEEN' }
  /** they asked about a payment and there is no order waiting on one */
  | { kind: 'NO_PAYMENT_PENDING' }
  | { kind: 'ORDER_CANCELLED' }
  | { kind: 'ORDER_REPLACED' }
  | { kind: 'ASK_WHICH'; sourceText: string; options: string[] }
  /**
   * ELICIT PREFERENCES, which the shop could not do at all before.
   *
   * MG-ShopDial lists this as a distinct agent intent and finds it in
   * ~11% of utterances. It is not the same as a clarification question:
   * ASK_WHICH narrows between candidates the ranker already found, this
   * one runs when the ranker found NOTHING and the shop has to open the
   * category up. "kuch snacks bhej do" used to dead-end at "samajh nahi
   * aaya"; now the KB gives the category and the shop names what it has.
   */
  | { kind: 'ELICIT'; sourceText: string; category: string; options: string[] }
  /**
   * REJECTION OF A SUBSTITUTE, which is not a cancellation.
   *
   * Splitting these is the paper's Negative feedback intent earning its
   * keep. "dhara nahi chahiye" used to cancel the entire order, because
   * the word nahi was all anything looked at.
   */
  | { kind: 'REJECTED'; rejected: string; options: string[] }
  /**
   * WE KNOW WHAT YOU MEAN AND WE DO NOT SELL IT.
   *
   * Distinct from NOT_UNDERSTOOD, and the distinction is the KB earning
   * its place. "kuch namkeen bhej do" is a perfectly clear request that
   * this shop cannot fill; answering it with "samajh nahi aaya" blames
   * the customer for the shop's shelf. Knowing the phrase names a real
   * product is what makes the honest answer possible.
   */
  | { kind: 'NOT_STOCKED'; product: string }
  | { kind: 'STILL_WAITING' }
  | { kind: 'NOT_UNDERSTOOD' }
  | { kind: 'ACCOUNT'; orders: number; spent: string }
  | { kind: 'NO_PREVIOUS_ORDER' }
  /**
   * A LISTING question, which MG-ShopDial files under QA next to factoid
   * and yes/no. It was the one of the three this shop could not answer:
   * "daal kaunsi kaunsi hai" got "main confirm kar leta hoon" while four
   * dals sat in the catalogue it had just searched.
   */
  | { kind: 'LISTING'; asked: string; options: string[] }
  /**
   * A PRICE question that matched several products.
   *
   * "atta ka kya rate h" was answered with four atta NAMES and no price,
   * which is not what was asked. Listing and pricing are both listing
   * questions in MG-ShopDial's schema, and the shop needs to tell them
   * apart: one wants to know what you stock, the other what it costs.
   */
  | { kind: 'PRICES'; asked: string; items: Array<{ name: string; price: string }> }
  /**
   * THE SHOP WAS ASKED TO CHOOSE, AND CHOSE.
   *
   * MG-ShopDial lists Recommend as an agent intent and this shop had no
   * way to perform one. Asked "aap hi bata do kaunsi acchi hai" it asked
   * the question back, which is the least useful thing available to it.
   *
   * `why` is COMPUTED -- see recommend() in core.ts -- because a reason
   * is exactly the kind of warm sentence a model will happily invent.
   * "Ye sabse acchi hai" is a claim about the world; "aap pichli baar
   * yahi le gaye the" is a claim about our own order table.
   */
  | {
      kind: 'RECOMMEND';
      name: string;
      price: string;
      /** already phrased as a justification, and true */
      why: string;
      /** what else was on the table, so they can still say no */
      alternatives: string[];
    }
  /** what the shop sells at all, for "kya kya hai" */
  | { kind: 'CATALOGUE'; categories: string[] }
  | { kind: 'QUESTION' }
  | { kind: 'STOCK_ANSWER'; name: string; inStock: boolean; price: string }
  | { kind: 'NOT_REGISTERED' }
  | { kind: 'NO_PHOTO' }
  /** the picture was not a shopping list */
  | { kind: 'PHOTO_NOT_A_LIST' }
  /** it was a list and nothing legible came off it */
  | { kind: 'PHOTO_EMPTY' }
  /** the vision call itself failed */
  | { kind: 'PHOTO_FAILED' };

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
      // EXPLAIN. Not "it was changed" -- what changed, to what, and why.
      const sub = f.substituted
        .map((sw) => ` ${sw.from} is out of stock so ${sw.to} was put in instead (${sw.why}). Say this plainly and say WHY, do not just say it was changed.`)
        .join('');
      /**
       * The pack question. Phrased as "you asked for X, it comes in Y" so
       * the customer can see the arithmetic rather than being told a
       * number they did not choose.
       */
      const packs = f.packAsks
        .map((a) =>
          ` NOTE: they asked for ${a.asked} of ${a.name}, but the shop only` +
          ` sells it in a ${a.sold} packet. Tell them BOTH of those amounts,` +
          ` the way a shopkeeper would -- "aapne ${a.asked} kaha, ye ${a.sold}` +
          ` ke packet mein aata hai" -- and ask if that is alright. Write the` +
          ` amounts, never the words "pack(s)" or a count of packets.`)
        .join('');

      /**
       * What was on the paper and is not on the card. Said out loud,
       * because the alternative is the customer discovering it when the
       * bag arrives without it.
       */
      const lost = f.dropped.length
        ? ` NOTE: they also asked for "${f.dropped.join('", "')}" and the shop could not match that to anything it sells. Tell them it is NOT on the list and ask what they meant. Do not guess.`
        : '';

      return `Their order is ready to send. Ask if you should send it.${sub}${packs}${lost}`;
    }

    case 'BASKET_ADDED': {
      const sub = f.substituted
        .map((sw) => ` ${sw.from} is out of stock so ${sw.to} was put in instead (${sw.why}). Say so and say WHY.`)
        .join('');
      const packs = f.packAsks
        .map((a) =>
          ` NOTE: they asked for ${a.asked} of ${a.name}, but the shop only` +
          ` sells it in a ${a.sold} packet. Tell them BOTH amounts and ask` +
          ` if that is alright. Write the amounts, never a count of packets.`)
        .join('');
      const lost = f.dropped.length
        ? ` NOTE: they also asked for "${f.dropped.join('", "')}" and the shop sells nothing like it. Say it is NOT on the list. Do not guess.`
        : '';

      return [
        `${f.added.join(' and ')} went into their basket.`,
        'Say so briefly and ask if they want anything else.',
        'Do NOT ask whether to send the order -- they will say when they',
        'are done. The running list is attached below your reply.',
      ].join(' ') + sub + packs + lost;
    }

    case 'BASKET_REVIEW':
      return [
        'They are done adding. The full basket is attached below your',
        'reply. Ask them to confirm you should send it.',
      ].join(' ');

    case 'BASKET_EMPTY':
      return [
        'They asked you to send the order but nothing is in the basket',
        'yet. Say so lightly and ask what they need.',
      ].join(' ');

    case 'ORDER_AMENDED':
      return 'They added to or changed the order. Acknowledge the change and ask if you should send it now.';

    case 'ORDER_CONFIRMED':
      return `The order is confirmed and going out. Reference ${f.ref}. Reassure them briefly.`;

    case 'AWAITING_PAYMENT':
      return [
        `Their order is placed and waiting on payment. Reference ${f.ref}.`,
        f.link
          ? 'The payment link is attached below your reply -- do NOT write'
            + ' it out yourself, and do not say the order is confirmed,'
            + ' because it is not until they pay.'
          : 'Online payment is not available right now, so tell them they'
            + ' can pay when the goods arrive.',
        'Keep it short.',
      ].join(' ');

    case 'PAYMENT_NOT_SEEN':
      return [
        'They say they have paid and the payment has NOT arrived yet.',
        'Do NOT agree that it is done and do NOT promise it will be fine.',
        'Say plainly that it has not shown up yet, that it sometimes takes',
        'a minute, and that the order goes through by itself the moment it',
        'does. Be warm about it -- they are probably telling the truth and',
        'the bank is slow.',
      ].join(' ');

    case 'NO_PAYMENT_PENDING':
      return [
        'They asked about a payment but nothing is waiting to be paid.',
        'Say so and ask if they want to order something.',
      ].join(' ');

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

    case 'ELICIT':
      return [
        `They asked for "${f.sourceText}", which is too broad to pick from.`,
        `The shop has these in ${f.category}: ${f.options.join(', ')}.`,
        'Name them and ask which they want. Do NOT number them, and do',
        'not say how much they asked for.',
      ].join(' ');

    case 'REJECTED':
      return [
        `They do not want ${f.rejected}.`,
        f.options.length
          ? `The shop also has: ${f.options.join(', ')}. Offer those instead.`
          : 'There is nothing else close to it. Say so and ask what they would like instead.',
        'The rest of their order is untouched. Do NOT number the options.',
      ].join(' ');

    case 'NOT_STOCKED':
      return [
        `They asked for ${f.product}. This shop does not stock it.`,
        'Say so plainly and without apologising twice. Do NOT suggest a',
        'replacement -- you were not given one, and inventing a substitute',
        'for something you do not carry is worse than saying no. Ask if',
        'they need anything else.',
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

    case 'LISTING':
      return [
        `They asked what the shop has for "${f.asked}".`,
        `It stocks: ${f.options.join(', ')}.`,
        'Name them all. This is the answer to their question, not a menu,',
        'so do NOT number them and do not ask them to pick yet -- though',
        'you may add that they can just say which one.',
      ].join(' ');

    case 'PRICES':
      return [
        `They asked the price of "${f.asked}" and the shop has more than`,
        `one: ${f.items.map((i) => `${i.name} ${i.price}`).join(', ')}.`,
        'Give every name WITH its price, exactly as written above -- the',
        'prices are the answer, not decoration. Do NOT number them.',
      ].join(' ');

    case 'RECOMMEND':
      return [
        'They asked YOU to choose, so choose -- do not hand the question',
        `back. You are recommending ${f.name}, ${f.price}.`,
        f.why
          ? `The reason is: ${f.why}. Say it. A recommendation without a`
            + ' reason is just a different way of picking at random, and'
            + ' the reason is the whole thing they asked you for.'
          : 'Recommend it plainly.',
        f.alternatives.length
          ? `If they would rather have something else, the shop also has:`
            + ` ${f.alternatives.join(', ')}. You may mention that they can`
            + ' still have one of those, briefly, at the end.'
          : '',
        'Then ask how much they want. Do NOT invent any other reason --',
        'not taste, not quality, not what other customers buy.',
      ].filter(Boolean).join(' ');

    case 'CATALOGUE':
      return [
        'They asked what the shop sells, or asked for something too broad',
        'to pick from.',
        `The shop stocks: ${f.categories.join(', ')}.`,
        'Tell them, in a natural sentence rather than a list, and ask what',
        'they need. Do NOT number anything and do NOT invent a category',
        'that is not in that list.',
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

    case 'PHOTO_NOT_A_LIST':
      return [
        'They sent a photo that is not a shopping list. Do NOT guess what',
        'was in it. Say you could not see a list in it and ask them to',
        'send the list, or just type what they need.',
      ].join(' ');

    case 'PHOTO_EMPTY':
      return [
        'They sent a photo of a list but none of it could be read --',
        'blurry, or too dark. Ask for a clearer picture, or for them to',
        'type it. Do NOT pretend to have read any of it.',
      ].join(' ');

    case 'PHOTO_FAILED':
      return [
        'The photo could not be opened at all, which is the fault of the',
        'shop and not theirs. Apologise once, briefly, and ask them to',
        'send it again or type the list.',
      ].join(' ');
  }
}

/**
 * The one line that differs between the two callers.
 *
 * compose() asks for JSON because a wrapped string is easy to validate
 * whole. composeStream() must not: a partial JSON response is an
 * unterminated string with a half-written escape. Removing
 * response_format while leaving this instruction in the prompt produced
 * exactly what you would expect -- the model obeyed the prompt, and the
 * shop read the characters {"reply": out loud to a customer.
 */
const RETURN_JSON = 'Return ONLY JSON: {"reply":"..."}';
const RETURN_PROSE = 'Return the sentence itself. No JSON, no quotes, no label.';

const SYSTEM = [
  'You are the person answering WhatsApp for a small neighbourhood kirana',
  'shop in India. You are not a bot and you do not sound like one.',
  '',
  RETURN_JSON,
  '',
  'HOW THIS ONE REPLY SHOULD LAND is in the THIS MOMENT block below.',
  'It is computed per turn -- what kind of moment this is, whether a',
  'reaction is warranted before the information, and the openings you',
  'have already used up. Follow it exactly. It knows what you have',
  'already said this conversation and you do not.',
  '',
  'HOW TO WRITE',
  '- Short. Two or three sentences at the very most. This is WhatsApp.',
  '- Warm and ordinary, the way a shopkeeper talks to a regular.',
  '- Say WHY. A shopkeeper handing over a different bottle says why in the',
  '  same breath, every time. Whenever the FACT gives you a reason, it',
  '  belongs in the sentence -- never state a change without it.',
  '- Talk about the SHOP, not the software. Things get "rakh diya", "daal',
  '  diya", "likh liya", "note kar liya". Never "added to your basket":',
  '  that is a database describing itself, and no shopkeeper has a basket.',
  '- Ji, haan ji, bilkul, accha, arre, koi baat nahi, theek hai. These',
  '  carry no information and are most of what makes speech sound spoken.',
  '- Their name is at the top of this prompt. Use it now and then, the way',
  '  you would across a counter -- not every message, which reads as a',
  '  mail merge, and not never, which reads as a form.',
  '- Mirror their SCRIPT exactly, and this matters more than it sounds.',
  '  If they typed in the Roman alphabet, reply in the Roman alphabet --',
  '  even when the language is Hindi. Someone who writes "daal kaunsi'
  + ' kaunsi h" cannot necessarily READ Devanagari.',
  '  Devanagari in, Devanagari out. English in, English out.',
  '- Never use numbered menus, option lists, or "reply 1 for".',
  '- Do not repeat a sentence you have already sent them, and do not open',
  '  two replies the same way. The recent messages are shown to you.',
  '  "Ye X add ho gaya, aur kuch chahiye?" every single turn is the tell',
  '  that gives a bot away faster than any single wrong answer.',
  '- No emoji unless they used one first.',
  '',
  'WHAT YOU MAY SAY',
  '- ONLY what the FACT below tells you. It is the entire truth you have.',
  '- Never invent or mention a product, price, total, stock level, delivery',
  '  time, shop timing or discount. If it is not in the FACT, you do not',
  '  know it, and saying the shopkeeper will confirm is always allowed.',
  '- Warmth is in the phrasing, never in the facts. "Ye aapke liye rakh',
  '  deta hoon" is warm and true; "ye sabse acchi hai" is warm and',
  '  invented, unless the FACT said so.',
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
  'Write NO digits and NO quantities of your own -- not how many items,',
  'not weights, not pack sizes, not prices. Say "ye" or "aapka order" and',
  'let the list speak for itself.',
  'The ONE exception is a pack-size NOTE in the fact above: those numbers',
  'were given to you and you must repeat them exactly as written.',
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
  /**
   * A pack question NEEDS its numbers -- "aapne 250g maanga, packet 500g
   * ka aata hai" is the whole point, and the blanket no-digits rule for
   * carded replies would have silenced it. Measured: the shop rounded
   * 250g up to a 500g packet and said nothing at all about having done so.
   *
   * The whitelist is what makes this safe to allow. These digits came out
   * of the catalogue and the customer's own message; anything the model
   * invents still fails.
   */
  if (f.kind === 'BASKET_ADDED') {
    for (const a of f.packAsks) source.push(a.asked, a.sold, String(a.units));
    source.push(...f.dropped, ...f.added);
  }
  if (f.kind === 'ORDER_DRAFT') {
    for (const a of f.packAsks) source.push(a.asked, a.sold, String(a.units));
    source.push(...f.dropped);
  }
  if (f.kind === 'ASK_WHICH') source.push(...f.options, f.sourceText);
  if (f.kind === 'ELICIT') source.push(...f.options, f.sourceText);
  if (f.kind === 'REJECTED') source.push(...f.options, f.rejected);
  if (f.kind === 'NOT_STOCKED') source.push(f.product);
  if (f.kind === 'LISTING') source.push(...f.options, f.asked);
  if (f.kind === 'PRICES') {
    for (const i of f.items) source.push(i.name, i.price);
    source.push(f.asked);
  }
  if (f.kind === 'RECOMMEND') source.push(f.name, f.price, f.why, ...f.alternatives);
  if (f.kind === 'CATALOGUE') source.push(...f.categories);
  if (f.kind === 'STOCK_ANSWER') source.push(f.name, f.price);
  if (f.kind === 'ACCOUNT') source.push(String(f.orders), f.spent);
  if (f.kind === 'ORDER_CONFIRMED') source.push(f.ref);
  if (f.kind === 'AWAITING_PAYMENT') source.push(f.ref);

  const out = new Set<string>();
  for (const s of source) for (const d of s.match(/\d+/g) ?? []) out.add(d);
  return out;
}

function violates(reply: string, allowed: Set<string>): boolean {
  if (/\btotal\b/i.test(reply)) return true;
  return (reply.match(/\d+/g) ?? []).some((d) => !allowed.has(d));
}

/** the prompt is identical either way; only the delivery differs */
function buildPrompt(input: ComposeInput): string {
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
    /**
     * The plan goes AFTER the fact and last of the two, because the
     * fact is the constraint and the delivery is the choice -- and the
     * thing nearest the end of a prompt is the thing most obeyed. It
     * was the fact that needed that position when the failure was
     * invention; with the facts holding, the failure moved to sameness.
     */
    `\n${deliveryBrief(direct(input.facts, input.recent, input.buyerName), input.buyerName)}`,
    input.card ? NO_NUMBERS : '',
  ].filter(Boolean).join('\n');

  return user;
}

export async function compose(input: ComposeInput): Promise<string> {
  const user = buildPrompt(input);

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

/**
 * THE SAME REPLY, HANDED OVER A SENTENCE AT A TIME.
 *
 * For voice. Words are useless to a caller until they are sound, and
 * sound cannot start until a sentence is finished -- so finishing the
 * FIRST sentence early is worth more than finishing the whole reply
 * early. Streaming the model overlaps synthesis of sentence one with the
 * writing of sentence two, which is the pattern the interview agent in
 * practers uses and the reason its turns feel immediate.
 *
 * NOT IN JSON MODE, and that is the entire reason this is a separate
 * function rather than a flag. A partial JSON response is partial JSON --
 * an unterminated string with a half-written escape -- and parsing that
 * incrementally is a lot of fragile code to recover a field that was
 * only ever called `reply`. Asking for the sentence directly costs
 * nothing: sanitise() and violates() were always what did the real work.
 *
 * EVERY SENTENCE IS CHECKED BEFORE IT IS HANDED OVER. Speaking as the
 * model writes must not become a way past the guard that stops
 * fabricated totals and invented quantities. Checking before the caller
 * ever sees it also means a bad sentence is never half-said and then
 * retracted, which is not a thing you can do to someone on a phone.
 */
export async function composeStream(
  input: ComposeInput,
  onSentence: (sentence: string) => void | Promise<void>,
): Promise<string> {
  const user = buildPrompt(input);
  const allowed = allowedDigits(input.facts);

  const said: string[] = [];
  let buffer = '';

  /** cut at .!? followed by whitespace; a decimal point has neither */
  const cut = (buf: string) => {
    const out: string[] = [];
    const re = /[\s\S]*?[.!?]+(?:\s|$)/g;
    let m: RegExpExecArray | null;
    let last = 0;
    while ((m = re.exec(buf)) !== null) {
      const s = m[0].trim();
      if (s) out.push(s);
      last = re.lastIndex;
    }
    return { done: out, rest: buf.slice(last) };
  };

  const offer = async (sentence: string) => {
    const clean = sentence.replace(/\s+/g, ' ').trim();
    if (!clean || violates(clean, allowed)) return;
    said.push(clean);
    await onSentence(clean);
  };

  try {
    const stream = await groq.chat.completions.create({
      model: env.GROQ_LLM_MODEL_FAST,
      temperature: 0.6,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM.replace(RETURN_JSON, RETURN_PROSE) },
        { role: 'user', content: user },
      ],
    });

    for await (const part of stream) {
      const delta = part.choices[0]?.delta?.content;
      if (!delta) continue;

      /**
       * A newline once something has been said is the model starting to
       * draw a list or a card -- exactly what sanitise() cuts on the
       * non-streaming path. Stop reading rather than try to repair it.
       */
      if (delta.includes('\n') && said.length) break;

      buffer += delta;
      const { done, rest } = cut(buffer);
      buffer = rest;
      for (const sentence of done) await offer(sentence);
    }

    if (buffer.trim()) await offer(buffer);
  } catch {
    // a duller sentence is fine; a dropped reply is not
  }

  if (!said.length) {
    await onSentence(input.fallback);
    said.push(input.fallback);
  }

  const reply = said.join(' ');
  return input.card ? `${reply}\n\n${input.card}` : reply;
}
