import { randomUUID } from 'node:crypto';
import { span } from '../telemetry/span.js';
import { routeOf } from './routing.js';
import { prisma } from '@nukkad/db';
import { rupeeLabel } from '@nukkad/shared';
import type { InboundMessage, OutboundMessage, ResolvedLine, Sku } from '@nukkad/shared';
import { transcribe } from '../asr/index.js';
import { isAudio, isImage } from '../asr/audio.js';
import { extractOrder } from '../extraction/extract.js';
import { parseList } from '../vision/list.js';
import type { Extraction } from '@nukkad/shared';
import { getCatalog, getStockMap } from '../catalog/cache.js';
import { buildPrior } from '../resolver/prior.js';
import { rankLine, DEFAULT_RANK, stripQuantity } from '../resolver/rank.js';
import { fuzzyScore } from '../resolver/fuzzy.js';
import { fitPack, displayNames, withoutPack } from '../resolver/pack.js';
import { findSubstitutes } from '../substitution/substitute.js';
import { hasVision, env } from '../../config/env.js';
import { readAnswer } from './reply.js';
import { resolve, pickFrom } from '../resolver/resolve.js';
import { decide, type PolicyAction } from '../policy/decide.js';
import { createRazorpayLink, recordInvoice, type RazorpayLink } from '../payments/razorpay.js';
import { checkAndSettle } from '../payments/settle.js';
import { maskActions } from '../resolver/action.js';
import { compose, composeStream, type Facts, type Swap, type PackAsk } from './compose.js';
import { retrieveKb } from '../kb/retrieve.js';
import type { Prior } from '../resolver/prior.js';
import {
  findConvo, loadConvo, save, flatten, isStale,
  type Convo, type Pending, type PendingLine, type OrderMeta,
} from './state.js';
import * as copy from './messages.js';

/**
 * The channel-agnostic brain.
 *
 * Nothing in this file imports Twilio, or fetch, or a transport SDK. It
 * takes an InboundMessage and returns OutboundMessages. That is exactly
 * what lets the web simulator run the identical pipeline as a real phone.
 *
 * TWO THINGS DECIDE THE SHAPE OF EVERY TURN.
 *
 * It is a STATE MACHINE, because a bot that asks a question and cannot
 * hear the answer is not an agent. See ./state.ts.
 *
 * And it does not WRITE any of what it says. Every buyer-facing sentence
 * goes through ./compose.ts, which phrases it in the customer's own
 * register. What survives here is the deciding: which SKU, which price,
 * which total, in stock or not, confirmed or not. The model gets those as
 * facts and is barred from inventing any of them.
 *
 * That split is why the numbered menu is gone. "1 = Pichhla order dobara
 * bhejo" was never a design choice, it was the absence of one -- the
 * system had a branch and no way to talk about it. Now REPEAT and ACCOUNT
 * are intents, recognised from what someone actually says.
 *
 * The order of a turn:
 *
 *   route to shop and household
 *   turn whatever arrived into text
 *   IF a question is outstanding, try to read this as the ANSWER
 *   otherwise, or if that fails, read the INTENT and act on it
 *
 * The "or if that fails" is load-bearing. A customer staring at a confirm
 * card who types "aur ek kilo chini bhi" has not answered anything, and a
 * machine that insists on a digit would throw that away.
 */

/**
 * The sandbox sender, read from config rather than written down.
 *
 * It was hardcoded to +1 415 523 8886, which was true of the old shared
 * sandbox and false of the newer per-trial ones -- a new account gets its
 * own number, inbound messages arrive addressed to THAT, and the fallback
 * below stops firing. The symptom is silence: every message resolves to
 * no shop and the handler returns nothing, which looks identical to the
 * webhook not being wired.
 */
const SANDBOX_NUMBER = env.TWILIO_WHATSAPP_FROM.replace('whatsapp:', '');

/** everything a handler needs, so signatures stay readable */
interface Ctx {
  convo: Convo;
  kiranaId: string;
  householdId: string;
  buyerName: string;
  /** E.164, needed on a Razorpay link and nowhere else */
  buyerPhone: string;
  shopName: string;
  /** what the buyer sent this turn, so the voice can mirror their register */
  said: string;
  meta: OrderMeta;
  /** filled in once the extractor has read this turn. See handle(). */
  annotation?: { intent: string; goal: string };
  /**
   * Voice only. When present the composer STREAMS and every finished
   * sentence arrives here as the model writes it, so speech can start
   * before the reply does. Absent on WhatsApp, where a partial message
   * would just be a message sent twice.
   */
  onSentence?: (sentence: string) => void | Promise<void>;
  onDecision?: (action: PolicyAction) => void;
}

/** say something true, in the customer's own words */
async function speak(
  ctx: Pick<Ctx, 'convo' | 'buyerName' | 'shopName' | 'said' | 'onSentence'>,
  facts: Facts,
  fallback: string,
  card?: string,
): Promise<OutboundMessage[]> {
  const input = {
    facts,
    said: ctx.said,
    buyerName: ctx.buyerName,
    shopName: ctx.shopName,
    recent: ctx.convo.recent,
    card,
    fallback,
  };

  /**
   * Streamed when somebody is listening for sentences, whole otherwise.
   * The two produce the same text; only the delivery differs, so nothing
   * downstream -- the transcript, the ledger, the annotation -- has to
   * know which one ran.
   */
  const text = ctx.onSentence
    ? await composeStream(input, ctx.onSentence)
    : await compose(input);

  return [{ text, ...label(facts) }];
}

/**
 * The shop's own utterance, on the same two axes as the customer's.
 *
 * Derived from the Facts rather than classified by a model, because the
 * agent already knows what it did -- a second opinion on its own action
 * would be strictly worse and cost a round trip. Only the inbound side
 * needs reading.
 *
 * Intent names follow MG-ShopDial's agent-side schema so the two halves of
 * a conversation are annotated in one vocabulary.
 */
function label(f: Facts): { intent: string; goal: string } {
  switch (f.kind) {
    case 'GREETING':
      return { intent: 'GREETINGS', goal: 'META' };
    case 'ORDER_DRAFT':
      // an explained substitution IS an explanation, and saying so is what
      // makes the 22.7% figure checkable against our own traffic
      return {
        intent: f.substituted.length ? 'EXPLAIN' : 'RECOMMEND',
        goal: 'ORDERING',
      };
    case 'ORDER_AMENDED':
    case 'BASKET_ADDED':
      return { intent: 'RECOMMEND', goal: 'ORDERING' };
    case 'BASKET_REVIEW':
      return { intent: 'CLARIFICATION_QUESTION', goal: 'ORDERING' };
    case 'BASKET_EMPTY':
      return { intent: 'OTHER', goal: 'ORDERING' };
    case 'ORDER_CONFIRMED':
      return { intent: 'POSITIVE_FEEDBACK', goal: 'ORDERING' };
    case 'AWAITING_PAYMENT':
      return { intent: 'INTERACTION_STRUCTURING', goal: 'ORDERING' };
    case 'PAYMENT_NOT_SEEN':
    case 'NO_PAYMENT_PENDING':
      return { intent: 'ANSWER', goal: 'ORDERING' };
    case 'ORDER_CANCELLED':
    case 'ORDER_REPLACED':
      return { intent: 'INTERACTION_STRUCTURING', goal: 'ORDERING' };
    case 'ASK_WHICH':
      return { intent: 'CLARIFICATION_QUESTION', goal: 'ORDERING' };
    case 'ELICIT':
      return { intent: 'ELICIT_PREFERENCES', goal: 'RECOMMENDATION' };
    case 'RECOMMEND':
      return { intent: 'RECOMMEND', goal: 'RECOMMENDATION' };
    case 'REJECTED':
      return { intent: 'RECOMMEND', goal: 'RECOMMENDATION' };
    case 'STILL_WAITING':
      return { intent: 'CLARIFICATION_QUESTION', goal: 'ORDERING' };
    case 'STOCK_ANSWER':
    case 'LISTING':
    case 'PRICES':
    case 'CATALOGUE':
      return { intent: 'ANSWER', goal: 'QA' };
    case 'ACCOUNT':
      return { intent: 'ANSWER', goal: 'QA' };
    case 'QUESTION':
      return { intent: 'ANSWER', goal: 'SEARCH' };
    case 'NOT_STOCKED':
      return { intent: 'ANSWER', goal: 'QA' };
    case 'NOT_UNDERSTOOD':
    case 'NO_PREVIOUS_ORDER':
    case 'NOT_REGISTERED':
    case 'NO_PHOTO':
    case 'PHOTO_NOT_A_LIST':
    case 'PHOTO_EMPTY':
    case 'PHOTO_FAILED':
      return { intent: 'OTHER', goal: 'META' };
  }
}

export async function handle(
  msg: InboundMessage,
  hooks: {
    onSentence?: (s: string) => void | Promise<void>;
    /**
     * Called the instant the policy layer picks an action, which is
     * roughly 600ms into a turn and well before there is anything to
     * say. The voice transport uses it to choose what noise to make
     * while the rest of the pipeline runs -- "dekhta hoon" for a
     * question and "karta hoon" for an add are different noises, and a
     * single generic filler becomes a tic by the third turn.
     */
    onDecision?: (action: PolicyAction) => void;
  } = {},
): Promise<OutboundMessage[]> {
  const started = Date.now();

  /**
   * MULTI-TENANT ROUTING. Order matters.
   *
   * Resolve the SHOP first, from the number the customer messaged, then the
   * household WITHIN that shop. Looking the customer up by phone alone is a
   * real bug the moment a second shop exists: the same person shops at two
   * kiranas, and you would silently serve them the wrong catalogue, the
   * wrong prices and the wrong stock.
   */
  /**
   * ROUTING IN ONE ROUND TRIP, not three.
   *
   * These three questions -- which shop, which household, what were we
   * talking about -- were asked one after another because each looked
   * like it needed the answer before it. Measured at 595ms before any
   * work began, on a link with a ~200ms floor to ap-northeast-2, which is
   * a fifth of a voice turn spent finding out who is speaking.
   *
   * Only the second dependency was real, and only in the rare case. The
   * household lookup by phone alone answers the common case outright --
   * it comes back with its kirana attached, so if that kirana is the one
   * the message was sent to, no further query is needed. The precise
   * per-tenant lookup below runs only when it is not, which means only
   * when one person shops at two kiranas.
   *
   * The conversation never depended on either. It is keyed by channel and
   * phone number, both of which are on the inbound message.
   */
  const [{ kirana: kiranaByNumber, household: knownHousehold }, convoRow] =
    await span('route', () => Promise.all([
      routeOf(msg.senderId, msg.recipientId),
      findConvo(msg.channel, msg.senderId),
    ]));

  let kirana = kiranaByNumber;

  /**
   * SANDBOX FALLBACK, and it is a fallback for one specific reason.
   *
   * Twilio's sandbox number (+1 415 523 8886) is SHARED by every sandbox
   * user in the world. It is not this shop's number, so it identifies
   * nothing. In production each shop connects its OWN number through Meta
   * Coexistence and the branch above resolves it correctly.
   *
   * Until then, resolve the shop from the customer. This is correct only
   * while a customer belongs to exactly one shop, which is true in the
   * demo and false in general. Delete this block the day real per-shop
   * numbers exist.
   */
  if (!kirana && msg.recipientId === SANDBOX_NUMBER) {
    kirana = knownHousehold?.kirana ?? null;
  }

  if (!kirana) {
    // Nothing registered on this number, so we cannot know whose catalogue
    // to answer from. Stay silent rather than guess wrong.
    return [];
  }

  /**
   * The prefetch answers this outright unless the customer shops at more
   * than one kirana, which is the only case that can put a household on
   * this phone number under a DIFFERENT shop.
   */
  const household = knownHousehold?.kiranaId === kirana.id
    ? knownHousehold
    : await span('db.household.exact', () => prisma.household.findUnique({
        where: { kiranaId_phone: { kiranaId: kirana!.id, phone: msg.senderId } },
      }));

  if (!household) {
    // No conversation row for an unknown number, so this one reply is
    // composed without any history to draw on.
    return speak(
      { convo: { id: '', pending: null, recent: [], basket: [], lastNamed: [] }, buyerName: 'ji', shopName: kirana.name, said: msg.text ?? '' },
      { kind: 'NOT_REGISTERED' },
      copy.NOT_REGISTERED,
    );
  }

  const convo = await span('db.convo', () => loadConvo(msg.channel, msg.senderId, household.id, kirana!.id, convoRow));

  // ---- 1. get text, from whichever modality arrived -------------------
  let text = msg.text ?? '';
  let transcript: string | null = null;
  let asrEngine: string | null = null;

  const audio = msg.media.find((m) => isAudio(m.mime));
  if (audio) {
    const t = await transcribe(audio.localPath);
    transcript = t.text;
    asrEngine = t.engine;
    text = t.text;
  }

  const ctx: Ctx = {
    convo,
    kiranaId: kirana.id,
    householdId: household.id,
    buyerName: household.name,
    buyerPhone: household.phone,
    shopName: kirana.name,
    said: text,
    onSentence: hooks.onSentence,
    onDecision: hooks.onDecision,
    meta: {
      source: audio ? 'VOICE' : 'TEXT',
      rawText: msg.text ?? null,
      transcript,
      asrEngine,
      mediaPath: audio?.localPath ?? null,
      startedAt: started,
    },
  };

  const out = await span('turn', () => turn(ctx, msg));

  /**
   * ANNOTATE THE INBOUND MESSAGE, two axes.
   *
   * updateMany rather than update because the row may not exist: the
   * Twilio route creates it before calling in, the simulator never does,
   * and a no-op is the right answer for the second case.
   *
   * This is the part of MG-ShopDial worth keeping even where its findings
   * do not transfer. Once every utterance carries an intent AND a goal you
   * can ask how a real shop's conversations actually move -- how often
   * ordering turns into a question, whether elicitation ever converts --
   * and answer it from production rather than from a guess.
   */
  /**
   * SCOPED BY CONVERSATION, AND NOT WAITED FOR.
   *
   * Two bugs in one line. The where clause named externalId alone, and
   * the only index covering it is @@unique([conversationId, externalId])
   * -- a composite cannot serve a lookup on its second column, so this
   * was a sequential scan of every message ever sent, measured at 637ms
   * and growing. Adding the conversation makes it an index hit, and makes
   * it correct: two transports can mint the same external id.
   *
   * And nothing in this turn reads it. It is annotation for later
   * analysis, so waiting for it only delays the reply. Errors are logged
   * rather than thrown, because a missing label is not worth failing a
   * conversation over.
   */
  const annotation = ctx.annotation;
  if (annotation) {
    void prisma.message
      .updateMany({
        where: { conversationId: convo.id, externalId: msg.externalId },
        data: annotation,
      })
      .catch((err) => console.error('annotate failed', err));
  }

  /**
   * ONE WRITE, at the end.
   *
   * The transcript is what stops the voice repeating itself, which is the
   * single most bot-like thing a bot does. Recording it here rather than in
   * each handler means no branch can forget to.
   */
  if (text.trim()) convo.recent.push({ role: 'user', text });
  for (const o of out) convo.recent.push({ role: 'shop', text: o.text });
  await span('db.save', () => save(convo, { householdId: household.id, kiranaId: kirana!.id }));

  return out;
}

async function turn(ctx: Ctx, msg: InboundMessage): Promise<OutboundMessage[]> {
  const image = msg.media.find((m) => isImage(m.mime));

  if (image && !hasVision) {
    // No multimodal model on this Groq account, so photo input is out of
    // scope rather than silently broken. Say so plainly.
    return speak(ctx, { kind: 'NO_PHOTO' }, copy.NO_PHOTO);
  }

  /**
   * A PHOTO OF A SHOPPING LIST IS AN ORDER.
   *
   * There used to be no branch here at all. The check above asked whether
   * vision was UNAVAILABLE, found it available, and fell through -- so the
   * image was dropped, the text stayed empty, and the message landed on
   * the empty-message path and was answered with a greeting. Someone sent
   * a picture of their grocery list and the shop said "kya haal hai".
   *
   * Photos jump the queue past any outstanding question on purpose. A
   * customer who was asked which rice they wanted and replies with a
   * photograph of their whole list has moved on, and holding them to the
   * old question would be pedantic.
   */
  if (image) {
    return photo(ctx, image.localPath);
  }

  // ---- is an answer outstanding? --------------------------------------
  let pending = ctx.convo.pending;

  if (pending && isStale(pending)) {
    // Six hours on, this is not an answer to anything. Retire it rather
    // than leave the order sitting in the shop's pending count forever.
    expire(ctx);
    pending = ctx.convo.pending = null;
  }

  if (!ctx.said.trim()) {
    // An empty message cannot answer a question, so re-ask rather than
    // drop whatever was outstanding.
    if (pending) return reAsk(ctx, pending);
    return speak(ctx, { kind: 'GREETING' }, copy.GREETING);
  }

  if (pending) {
    const answered = await answer(ctx, pending);
    // null means "this was not an answer" -- fall through and read it as
    // a new instruction, which is nearly always what the customer meant
    if (answered) return answered;

    /**
     * WHATEVER WAS ALREADY SETTLED GOES IN THE BAG FIRST.
     *
     * Asked which rice, a customer may answer with a rice the shop did
     * not think to offer. That is not an answer, so it falls through --
     * and the atta they had ALREADY been understood about was sitting in
     * the pending question, not in the basket, so it vanished. One
     * unanswered question, two items ordered, one item lost.
     */
    if (pending.kind === 'DISAMBIGUATE') {
      const settled = pending.lines.filter((l) => l.skuId && !l.needsDisambiguation);
      if (settled.length) ctx.convo.basket = mergeBasket(ctx.convo.basket, settled);
    }

    /**
     * NOT AN ANSWER, SO IT IS A NEW INSTRUCTION -- and nothing is at risk.
     *
     * This used to be twenty lines of rescue: cancel the AWAITING order,
     * carry its lines forward, merge them back in. All of that existed
     * because an unrecognised reply would otherwise have thrown away an
     * order the customer had already agreed to.
     *
     * The basket removes the problem rather than handling it. It is
     * conversation state, it is not touched by falling through, and
     * whatever they said next simply adds to it.
     */
    ctx.convo.pending = null;
  }

  return act(ctx);
}

/**
 * Read the picture, then hand the words to the ordinary ranker.
 *
 * Nothing below the extraction is photo-specific, and that is the point:
 * the catalogue constraint does not care which sense the words arrived by,
 * so a handwritten "Cooking oil 1L" is ranked exactly as a spoken one is.
 */
async function photo(ctx: Ctx, path: string): Promise<OutboundMessage[]> {
  let result;
  try {
    result = await parseList(path);
  } catch {
    // a vision outage is not the customer's problem to decode
    ctx.annotation = { intent: 'OTHER', goal: 'META' };
    return speak(ctx, { kind: 'PHOTO_FAILED' }, copy.PHOTO_FAILED);
  }

  const { list } = result;

  if (!list.isList) {
    /**
     * Not a list. Say so rather than ordering whatever the model imagined
     * it saw -- a model asked to find groceries in a picture of a dog will
     * find groceries in a picture of a dog.
     */
    ctx.annotation = { intent: 'OTHER', goal: 'META' };
    return speak(ctx, { kind: 'PHOTO_NOT_A_LIST' }, copy.PHOTO_NOT_A_LIST);
  }

  if (!list.items.length) {
    ctx.annotation = { intent: 'OTHER', goal: 'META' };
    return speak(ctx, { kind: 'PHOTO_EMPTY' }, copy.PHOTO_EMPTY);
  }

  ctx.meta = { ...ctx.meta, source: 'PHOTO', mediaPath: path };
  return act(ctx, list.items);
}

// ---------------------------------------------------------------- intents

/**
 * Read what they want and do it.
 *
 * This is where the four-item menu used to be. Every branch below was
 * previously a number the customer had to find and type.
 */
async function act(
  ctx: Ctx,
  /**
   * Items already read off a photographed list. When present the text
   * extractor is skipped -- there is no text to extract from, and the
   * picture has already said what it says.
   */
  fromPhoto?: Extraction['items'],
): Promise<OutboundMessage[]> {
  /**
   * A NO WITH A BASKET OPEN MEANS SOMETHING, whatever the label says.
   *
   * Rejection used to live only inside the checkout answer, because that
   * was the only moment an order existed to reject. With a basket the
   * customer can take something out at any point, and they do:
   *
   *   sugar nahi chahiye  -> "Sugar hai. Kitna bhejun?"  (a stock answer)
   *   nahi rehne do       -> the whole category list, basket untouched
   *
   * Checked before the extractor is even consulted, because this is
   * precisely the case where its label is least reliable and least
   * needed. Long sentences do not reach here -- readAnswer returns
   * UNKNOWN past three words -- so "nahi teen kilo chini karo" stays a
   * correction rather than becoming a refusal.
   */
  if (!fromPhoto && ctx.convo.basket.length) {
    const said = readAnswer(ctx.said, 0);
    if (said.kind === 'NO') {
      ctx.annotation = { intent: 'NEGATIVE_FEEDBACK', goal: 'ORDERING' };
      const dropped = dropFromBasket(ctx);
      if (dropped) return dropped;

      ctx.convo.basket = [];
      ctx.convo.pending = null;
      return speak(ctx, { kind: 'ORDER_CANCELLED' }, copy.CANCELLED);
    }
  }

  /**
   * A PHOTOGRAPHED LIST SKIPS THE POLICY MODEL ENTIRELY.
   *
   * There is no ambiguity to resolve: the items came off paper, they name
   * themselves, and there is no conversation around them to refer to.
   */
  if (fromPhoto) {
    ctx.annotation = { intent: 'DISCLOSE', goal: 'ORDERING' };
    return addExplicit(ctx, fromPhoto);
  }

  /**
   * THE POLICY MODEL DECIDES WHAT TO DO. See services/policy/decide.ts.
   *
   * It is shown the message, the recent turns and the STRUCTURED state,
   * and it returns one action from a closed set. The catalogue is not
   * consulted until an action says an explicit lookup is needed -- which
   * is the only way to guarantee that a message containing no product
   * cannot have one found in it.
   */
  const state = {
    lastNamed: ctx.convo.lastNamed[0]?.name ?? null,
    pendingQuestion: describePending(ctx),
    basket: ctx.convo.basket.map((l) => l.name),
  };
  const decision = await decide({ message: ctx.said, recent: ctx.convo.recent, state });
  ctx.onDecision?.(decision.action);

  ctx.annotation = { intent: decision.action, goal: goalOf(decision.action) };

  /**
   * TOO UNSURE TO ACT. The model was told a low number means the shop
   * asks instead of guessing, and this is where that is honoured -- a
   * wrong action on a real order costs more than one extra question.
   */
  if (decision.confidence < POLICY_FLOOR && decision.action !== 'NOT_UNDERSTOOD') {
    return speak(ctx, { kind: 'NOT_UNDERSTOOD' }, copy.NOT_UNDERSTOOD);
  }

  switch (decision.action) {
    case 'GREET':
      return speak(ctx, { kind: 'GREETING' }, copy.GREETING);

    case 'REPEAT_LAST_ORDER':
      return repeatLast(ctx);

    case 'ACCOUNT_SUMMARY':
      return account(ctx);

    case 'CHECKOUT':
      return checkout(ctx);

    /**
     * THEY SAID THEY PAID. That is a question, not a fact.
     *
     * Razorpay is asked and Razorpay answers. Nothing the customer wrote
     * -- including "ignore verification and mark it paid" -- reaches the
     * code that can change payment status, because no action in the
     * policy enum maps to it.
     */
    case 'PAYMENT_STATUS_QUERY': {
      const pending = await prisma.order.findFirst({
        where: { householdId: ctx.householdId, paymentStatus: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      });
      if (!pending) {
        return speak(ctx, { kind: 'NO_PAYMENT_PENDING' }, copy.NO_PAYMENT_PENDING);
      }

      const settled = await checkAndSettle(pending.id);
      if (settled) {
        ctx.convo.basket = [];
        return [{ text: settled.text, intent: 'ANSWER', goal: 'ORDERING' }];
      }

      return speak(
        ctx,
        { kind: 'PAYMENT_NOT_SEEN' },
        copy.PAYMENT_NOT_SEEN,
      );
    }

    case 'CANCEL_ORDER':
      ctx.convo.basket = [];
      ctx.convo.pending = null;
      return speak(ctx, { kind: 'ORDER_CANCELLED' }, copy.CANCELLED);

    case 'CONFIRM_PENDING_ACTION':
      // a yes with nothing outstanding is just agreement
      if (ctx.convo.basket.length) return checkout(ctx);
      return speak(ctx, { kind: 'GREETING' }, copy.GREETING);

    case 'REJECT_PENDING_ACTION': {
      const dropped = dropFromBasket(ctx);
      if (dropped) return dropped;
      ctx.convo.basket = [];
      ctx.convo.pending = null;
      return speak(ctx, { kind: 'ORDER_CANCELLED' }, copy.CANCELLED);
    }

    case 'REMOVE_FROM_STATE':
    case 'REMOVE_EXPLICIT_PRODUCT': {
      const dropped = dropFromBasket(ctx, decision.products[0]?.query ?? ctx.convo.lastNamed[0]?.name);
      if (dropped) return dropped;
      return speak(ctx, { kind: 'NOT_UNDERSTOOD' }, copy.NOT_UNDERSTOOD);
    }

    /**
     * NO SEARCH HAPPENS HERE. The product is the one the conversation was
     * already about, and its id is in the state -- so "haan daal do" can
     * never turn into Toor Dal, whatever the catalogue would have said.
     */
    case 'ADD_FROM_STATE': {
      const named = ctx.convo.lastNamed[0];
      const catalogue = await getCatalog(ctx.kiranaId);
      const sku = named && catalogue.find((x) => x.id === named.skuId);
      if (!sku) return speak(ctx, { kind: 'NOT_UNDERSTOOD' }, copy.NOT_UNDERSTOOD);

      return addExplicit(ctx, [{
        text: sku.name,
        quantity: decision.products[0]?.quantity ?? 1,
        unit: decision.products[0]?.unit ?? null,
      }], sku);
    }

    case 'ADD_EXPLICIT_PRODUCT':
      return addExplicit(ctx, decision.products.map((p) => ({
        text: p.query, quantity: p.quantity, unit: p.unit,
      })));

    case 'ANSWER_PRICE':
    case 'ANSWER_STOCK':
    case 'SEARCH_PRODUCT':
      return question(ctx, decision.products.map((p) => p.query));

    case 'RECOMMEND':
      return recommend(ctx, decision.products.map((p) => p.query));

    case 'CLARIFY':
    case 'NOT_UNDERSTOOD':
    default:
      return question(ctx, []);
  }
}

/** below this the shop asks rather than acts */
const POLICY_FLOOR = 0.45;

/**
 * How well the WHOLE SENTENCE must match before it counts as naming a
 * product. See the note at the use site in question(): a span carries a
 * judgement that a product was named, a bare sentence carries none.
 */
const SENTENCE_FLOOR = 0.7;

/** the paper's goal axis, derived from the action rather than classified */
function goalOf(action: PolicyAction): string {
  if (action === 'GREET') return 'META';
  if (action === 'ANSWER_PRICE' || action === 'ANSWER_STOCK' || action === 'ACCOUNT_SUMMARY') return 'QA';
  if (action === 'SEARCH_PRODUCT') return 'SEARCH';
  if (action === 'CLARIFY' || action === 'NOT_UNDERSTOOD') return 'META';
  return 'ORDERING';
}

/** what the shop is waiting on, in words the policy model can use */
function describePending(ctx: Ctx): string | null {
  const p = ctx.convo.pending;
  if (!p) return null;
  if (p.kind === 'CHECKOUT') return 'whether to send the order';
  return `which product they meant: ${p.options.map((o) => o.name).join(', ')}`;
}

/**
 * Rank named products against the catalogue and put them in the basket.
 *
 * `settled` short-circuits the ranker for a product the state already
 * identified by id -- there is nothing to search for and searching could
 * only introduce an error.
 */
async function addExplicit(
  ctx: Ctx,
  items: Array<{ text: string; quantity: number; unit: string | null }>,
  settled?: Sku,
): Promise<OutboundMessage[]> {
  // ---- rank against THIS shop's catalogue, with THIS household's prior
  const [catalog, stock, prior] = await Promise.all([
    getCatalog(ctx.kiranaId),
    getStockMap(ctx.kiranaId),
    buildPrior(ctx.householdId),
  ]);

  /**
   * ONE RESOLUTION STEP, WITH EVERYTHING IT NEEDS.
   *
   * Pointer substitution, the raw-text fallback and the ranking all live
   * in resolver/resolve.ts now, so this path and the question path and
   * the answer path cannot disagree about what a phrase means. See the
   * note at the top of that file for the six matchers this replaced.
   */
  /**
   * A product the policy layer already identified by id needs no ranking
   * at all -- see ADD_FROM_STATE. Everything else goes through the one
   * resolver, on the customer's own words.
   */
  const refs = settled
    ? items.map((it) => ({
        sourceText: it.text,
        quantity: it.quantity,
        unitHint: it.unit,
        line: {
          sourceText: it.text,
          quantity: it.quantity,
          unitHint: it.unit,
          chosen: { sku: settled, score: 1, fuzzy: 1, specificity: 99, method: 'EXACT' as const },
          alternates: [],
          confidence: 1,
          needsDisambiguation: false,
        },
        fromPointer: true,
      }))
    : resolve({
        text: ctx.said,
        spans: items,
        catalogue: catalog,
        prior,
        lastNamed: ctx.convo.lastNamed,
      });

  /**
   * A pointer with nothing to point at is a question, not a failure.
   * "yeh" used to be ranked as a product name and came back dry yeast.
   */
  const dangling = refs.find((r) => r.fromPointer && !r.line);
  if (dangling) {
    const options = displayNames(ctx.convo.lastNamed.map((n) => n.name));
    return speak(
      ctx,
      options.length
        ? { kind: 'ASK_WHICH', sourceText: dangling.sourceText, options }
        : { kind: 'NOT_UNDERSTOOD' },
      options.length ? copy.askWhich(dangling.sourceText, options) : copy.NOT_UNDERSTOOD,
    );
  }

  const resolved: ResolvedLine[] = refs.map(
    (r) => r.line ?? {
      sourceText: r.sourceText,
      quantity: r.quantity,
      unitHint: r.unitHint,
      chosen: null,
      alternates: [],
      confidence: 0,
      needsDisambiguation: false,
    },
  );

  // ---- stock check and substitution BEFORE the card, never after ------
  const substituted: Swap[] = [];
  for (const line of resolved) {
    if (!line.chosen) continue;
    if ((stock.get(line.chosen.sku.id) ?? 0) >= line.quantity) continue;

    const subs = findSubstitutes(line.chosen.sku, catalog, stock, prior);
    if (subs.length) {
      substituted.push({
        from: line.chosen.sku.name,
        to: subs[0]!.sku.name,
        why: whySwap(line.chosen.sku, subs[0]!.sku, prior),
      });
      line.alternates = [line.chosen, ...line.alternates].slice(0, 2);
      line.chosen = subs[0]!;
    }
  }

  /**
   * WHAT THEY ASKED FOR IS NOT ALWAYS HOW IT IS SOLD.
   *
   * Until this ran, every quantity was treated as a count of packets
   * whatever unit the customer used, so "Tea 500 g" ordered 250 packets
   * of 500g. See resolver/pack.ts. A request that does not divide into
   * whole packets is collected here and asked about on the card rather
   * than rounded in silence.
   */
  const mismatched: PackAsk[] = [];
  for (const line of resolved) {
    // fitted only when the SKU is FINAL -- a line still going out as a
    // question has no pack size yet. See the answer() branch for the
    // other half.
    if (!line.chosen || line.needsDisambiguation) continue;
    const ask = applyPack(line, line.chosen.sku);
    if (ask) mismatched.push(ask);
  }

  /**
   * NOTHING MATCHED. Open the category instead of giving up.
   *
   * "kuch snacks bhej do" used to end at "samajh nahi aaya", which is a
   * dead end for a request a shopkeeper answers every day. MG-ShopDial
   * treats eliciting preferences as its own agent intent for exactly this
   * reason: when you cannot tell what they want, the move is to narrow it
   * with them, not to fail.
   */
  let elicitedCategory: string | null = null;
  const lost = resolved.find((l) => !l.chosen);
  if (lost) {
    const opened = await openCategory(lost.sourceText, catalog, stock);

    /**
     * Nothing near it, but the KB recognises the phrase. That is not
     * confusion, it is a shelf this shop does not have -- and saying
     * "samajh nahi aaya" to a clear request blames the customer for it.
     */
    if (!opened && resolved.length === 1) {
      const known = (await retrieveKb(lost.sourceText, 1))[0];
      if (known) {
        return speak(
          ctx,
          { kind: 'NOT_STOCKED', product: known.canonical },
          copy.notStocked(known.canonical),
        );
      }
    }

    if (opened) {
      lost.alternates = opened.options.map((sku) => ({
        sku, score: 0, fuzzy: 0, specificity: 0, method: 'UNRESOLVED' as const,
      }));
      lost.needsDisambiguation = true;
      elicitedCategory = opened.category;
    }
  }

  const lines = resolved.map(flatten);
  if (elicitedCategory && lost) {
    /**
     * Marked on the LINE rather than held in a module-level map, because
     * the question can outlive the turn: a customer who ignores it and
     * comes back an hour later must be re-asked the same way.
     */
    const at = lines.find((l) => l.sourceText === lost.sourceText);
    if (at) at.elicitedCategory = elicitedCategory;
  }

  return advance(ctx, lines, false, substituted, mismatched);
}

/**
 * Convert a requested amount into packets, on the line, once.
 *
 * Returns the question to ask when it does not divide, or null when it
 * does. Mutating here rather than at the call sites is deliberate: there
 * are two places a SKU becomes final and both must convert identically.
 */
function applyPack(
  line: { quantity: number; unitHint: string | null },
  sku: Sku,
): PackAsk | null {
  const fit = fitPack(line.quantity, line.unitHint, sku);
  line.quantity = fit.units;
  return fit.exact
    ? null
    : { asked: fit.asked, sold: fit.sold, name: sku.name, units: fit.units };
}

/**
 * Why this bottle instead of that one, in the shop's own terms.
 *
 * The substitute ranker already weighs price, pack size and familiarity;
 * this reads back whichever of those actually carried the decision, so the
 * explanation is the real reason rather than a pleasant-sounding one.
 */
function whySwap(from: Sku, to: Sku, prior: Prior): string {
  if ((prior.get(to.id) ?? 0) > 0.2) return 'aap ye pehle le chuke hain';
  if (to.sellPaise < from.sellPaise) return 'thoda sasta bhi hai';
  if (to.sellPaise === from.sellPaise) return 'same daam';
  if (to.packSize === from.packSize && to.unit === from.unit) return 'wahi size';
  return 'sabse paas ka hai';
}

/**
 * What the shop has in the category the customer was gesturing at.
 *
 * The KB lookup is the RAG layer already used by the bill agent, pointed
 * at a new job: it maps a loose phrase to a canonical product and its
 * CATEGORY by trigram similarity, so "namkeen", "snacks" and "kuch chatpata"
 * all land somewhere the catalogue can be filtered by.
 *
 * Returns null rather than guessing when the category is unknown or the
 * shop stocks nothing in it -- an elicitation naming zero products is
 * worse than admitting confusion.
 */
async function openCategory(
  sourceText: string,
  catalog: Sku[],
  stock: Map<string, number>,
): Promise<{ category: string; options: Sku[] } | null> {
  /**
   * WIDE RECALL FROM THE KB, PRECISION FROM THE SHOP.
   *
   * Eight, not three, and the reason is that word-level trigram matching
   * saturates: "flour" scores a perfect 1.00 against bajra, makki, kuttu,
   * besan and wheat alike, and which three of those come back first is
   * arbitrary. Nothing lexical distinguishes them, and nothing should --
   * the KB is a national list of everything called flour, and the question
   * is which of them THIS shop sells.
   *
   * So the KB casts wide and the catalogue does the deciding. A shop
   * stocking only wheat atta gets wheat atta, without anyone writing down
   * that plain "flour" means atta.
   */
  const hits = await retrieveKb(sourceText, 8);
  if (!hits.length) return null;

  /**
   * RANK THE KB'S NAMES AGAINST THIS SHOP. Do not join on category.
   *
   * The first version of this filtered the catalogue by `s.category ===
   * hit.category` and never fired once, for a reason worth writing down:
   * the two vocabularies are unrelated. The KB files things under snacks,
   * pooja, homecare; a shop's own catalogue says wheat_atta, edible_oil,
   * biscuit. Parle-G sits in `biscuit` here and in `snacks` there. Nothing
   * short of a hand-written mapping table would make that join work, and a
   * hand-written mapping is exactly the sort of thing that rots.
   *
   * So the bridge is ranking, which is the bridge everywhere else in this
   * system. The KB knows that "namkeen" means Namkeen Bhujia; the ranker
   * knows what this shop can offer against that name. No new vocabulary,
   * no mapping to maintain, and it works for a shop whose categories were
   * typed in by hand.
   */
  const none: Prior = new Map();
  const found = new Map<string, Sku>();

  for (const hit of hits) {
    const line = rankLine(hit.canonical, 1, null, catalog, none, DEFAULT_RANK);

    /**
     * Scored on `fuzzy`, NOT on `confidence`, and the first version had
     * this wrong. Confidence is the MARGIN over the runner-up, which is
     * the right question when picking one SKU and precisely the wrong one
     * here: a shop with three attas has three near-identical scores, so
     * the margin collapses and the confidence is low exactly when the
     * shop is best able to help. "Flour" found nothing for that reason
     * alone -- the KB knew it meant atta, the shop had three, and the
     * margin between them vetoed all of it.
     *
     * The question this asks is "does the shop stock anything that
     * matches these words", which is lexical strength and nothing else.
     */
    if (!line.chosen || line.chosen.fuzzy < NEARBY_FLOOR) continue;
    if ((stock.get(line.chosen.sku.id) ?? 0) <= 0) continue;
    found.set(line.chosen.sku.id, line.chosen.sku);
  }

  const options = [...found.values()].slice(0, 4);
  return options.length >= 2 ? { category: hits[0]!.category, options } : null;
}

/**
 * How close a shop SKU must be to a KB product before the shop claims to
 * have something like it. Above the ranker's own floor on purpose: this is
 * offering an alternative unprompted, which deserves more certainty than
 * answering a direct request.
 */
const NEARBY_FLOOR = 0.5;



/**
 * "Atta hai kya?" gets a real answer, because the shop knows.
 *
 * Deflecting a stock question to the shopkeeper when the catalogue is
 * sitting right there is the sort of thing that makes an assistant feel
 * useless. Anything NOT about a stocked product still deflects, honestly,
 * rather than inventing shop timings.
 */
async function question(ctx: Ctx, spans: string[]): Promise<OutboundMessage[]> {
  /**
   * A question does not disturb the basket, but it should not hide it
   * either -- someone who asks what sugar costs mid-shop still wants to
   * see what is already in the bag.
   */
  const card = ctx.convo.basket.length ? copy.orderCard(ctx.convo.basket) : undefined;

  const [catalog, stock, prior] = await Promise.all([
    getCatalog(ctx.kiranaId),
    getStockMap(ctx.kiranaId),
    buildPrior(ctx.householdId),
  ]);

  /**
   * Fall back to the WHOLE SENTENCE when no span came out.
   *
   * The extractor returns a product span most of the time and not always,
   * and when it did not the shop said "mujhe abhi pata nahi hai" to
   * "moong dal ka price kitna h" -- with moong dal sitting in the
   * catalogue and its name sitting in the question. Matching is robust to
   * the extra words; having nothing to match is not.
   */
  const asked = spans[0] ?? ctx.said;

  /**
   * A WHOLE SENTENCE IS WEAKER EVIDENCE THAN A SPAN, and it needs a floor
   * under it that a span does not.
   *
   * When the policy layer hands over a span, somebody has already judged
   * that a product was named. When it hands over nothing and this falls
   * back to the raw sentence, nobody has -- and the ranker will always
   * find something, because trigram similarity has no opinion about
   * whether a sentence is about groceries. Measured:
   *
   *   moong dal ka price kitna h        Moong Dal      .830   real
   *   dukaan kitne baje tak khuli hai   Tata Tea Gold  .588   noise
   *
   * The second is the shop answering a question about opening hours by
   * quoting the price of tea, which is worse than any honest "I will
   * check" and was the whole reason the QUESTION fact existed. So the
   * fallback path -- and only that path -- has to clear a bar.
   */
  const floor = spans.length ? 0 : SENTENCE_FLOOR;

  if (asked.trim()) {
    /**
     * The SAME resolver, so a price question and an order find the same
     * product. `matching` used to be a second implementation living here
     * with its own direction and its own floor, which is how "moong dal
     * ka price kitna h" resolved for ordering and not for asking.
     */
    const [ref] = resolve({
      text: asked,
      spans: [],
      catalogue: catalog.filter((s) => (stock.get(s.id) ?? 0) > 0),
      prior,
      lastNamed: ctx.convo.lastNamed,
    });

    /**
     * PEERS ONLY, and a peer is one that explains as much of the question.
     *
     * `alternates` is banded on raw score, which is right for offering a
     * choice and wrong for answering a question. Asked "besan wala aata
     * ka price", the besan came top and Aashirvaad Atta and Tata Salt
     * cleared the band behind it -- so the shop treated a one-product
     * question as a three-product listing, and REMEMBERED all three. When
     * the customer then said "yeh bhi", there was no single thing they
     * could have meant.
     *
     * Besan accounts for two words of that question; the other two
     * account for one each. They are not alternatives to it.
     */
    const top = ref?.line?.chosen && ref.line.chosen.fuzzy >= floor
      ? ref.line.chosen
      : null;
    const found = top
      ? [top.sku, ...ref!.line!.alternates
          .filter((a) => a.specificity >= top.specificity)
          .map((a) => a.sku)]
      : [];

    if (found.length === 1) {
      const sku = found[0]!;
      remember(ctx, [sku]);
      return speak(ctx, {
        kind: 'STOCK_ANSWER',
        name: withoutPack(sku.name),
        inStock: (stock.get(sku.id) ?? 0) > 0,
        price: rupeeLabel(sku.sellPaise),
      }, copy.stockAnswer(withoutPack(sku.name), true), card);
    }

    if (found.length > 1) {
      remember(ctx, found);
      const shown = displayNames(found.map((x) => x.name));

      /**
       * "kaunsi kaunsi hai" and "kya rate hai" are both listing
       * questions, and answering them the same way answers only one.
       * Asked the rate of atta the shop replied with four atta names and
       * no prices at all.
       */
      if (asksPrice(ctx.said)) {
        const items = found.map((sku, i) => ({
          name: shown[i]!, price: rupeeLabel(sku.sellPaise),
        }));
        return speak(ctx, { kind: 'PRICES', asked, items }, copy.prices(items), card);
      }

      return speak(
        ctx,
        { kind: 'LISTING', asked, options: shown },
        copy.listing(shown),
        card,
      );
    }
  }

  /**
   * No product in the question at all -- "show categories", "kya kya hai".
   * The shop knows exactly what it sells, so saying "I will check" is a
   * strange thing for it to do.
   */
  return speak(
    ctx,
    { kind: 'CATALOGUE', categories: categoriesOf(catalog, stock) },
    copy.catalogue(categoriesOf(catalog, stock)),
    card,
  );
}

/**
 * THE SHOP CHOOSES, BECAUSE IT WAS ASKED TO.
 *
 * "aap hi bata do kaunsi acchi hai" used to reach question(), which
 * searched for a product in a sentence that names none, found the four
 * dals it had listed a moment ago and asked which one -- the same
 * question, back at someone who had just said they did not know. Two
 * turns of that and the customer picks at random or leaves.
 *
 * A shopkeeper asked to choose does three things: picks one, says why,
 * and leaves the door open. So does this.
 *
 * THE REASON IS COMPUTED, NEVER WRITTEN. That is the whole design of the
 * thing. Handing a model the option names and asking it to recommend one
 * gets you "ye sabse acchi quality ki hai", which is a claim about the
 * world that nobody checked -- the exact class of sentence the Facts
 * split exists to keep out. What goes in the fact is a reason this
 * codebase can defend:
 *
 *   they have bought it before   the order table says so
 *   it is the cheapest of these  sellPaise says so
 *
 * and when neither is true the shop names one and gives no reason at
 * all, which is honest and still more use than a question.
 *
 * WHY THE PRIOR IS THE FIRST CHOICE, and not merely the first available.
 * "Aap pichli baar yahi le gaye the" is the one thing a shop can say
 * that no amount of model quality can substitute for -- it is the
 * memory of a regular, which is what a kirana actually sells. It is also
 * already loaded on this path for the ranker, so it costs nothing.
 */
async function recommend(ctx: Ctx, spans: string[]): Promise<OutboundMessage[]> {
  const card = ctx.convo.basket.length ? copy.orderCard(ctx.convo.basket) : undefined;

  const [catalog, stock, prior] = await Promise.all([
    getCatalog(ctx.kiranaId),
    getStockMap(ctx.kiranaId),
    buildPrior(ctx.householdId),
  ]);

  const inStock = catalog.filter((s) => (stock.get(s.id) ?? 0) > 0);

  /**
   * WHAT WAS ON THE TABLE, in priority order.
   *
   * The conversation first: "aap bata do" almost always follows the shop
   * having just named some options, and those options are exactly what
   * lastNamed holds. Only when they asked cold -- "koi acchi chai de
   * do" -- is there anything to search for, and then the ordinary
   * resolver does it so a recommendation cannot find products an order
   * would not have.
   */
  const remembered = ctx.convo.lastNamed
    .map((n) => inStock.find((s) => s.id === n.skuId))
    .filter((s): s is Sku => !!s);

  let options = remembered;
  if (options.length < 2) {
    const asked = spans[0] ?? ctx.said;
    const [ref] = resolve({
      text: asked, spans: [], catalogue: inStock, prior, lastNamed: ctx.convo.lastNamed,
    });
    const top = ref?.line?.chosen;
    if (top) options = [top.sku, ...ref!.line!.alternates.map((a) => a.sku)];
  }

  /**
   * Nothing to choose between. Not a failure -- it is a question the
   * shop cannot answer yet, and question() already knows how to say so
   * without pretending otherwise.
   */
  if (!options.length) return question(ctx, spans);

  /**
   * The pick. History wins; price breaks the tie, because between two
   * things a customer has never bought, the cheaper one is the only
   * difference the shop can honestly point at.
   */
  const pick = [...options].sort((a, b) => {
    const pa = prior.get(a.id) ?? 0;
    const pb = prior.get(b.id) ?? 0;
    if (pa !== pb) return pb - pa;
    return a.sellPaise - b.sellPaise;
  })[0]!;

  const bought = (prior.get(pick.id) ?? 0) > 0;
  const cheapest = options.length > 1 && options.every((o) => o.sellPaise >= pick.sellPaise);

  const why = bought
    ? 'this household has ordered this same one before'
    : cheapest
      ? 'it is the cheapest of the ones on offer'
      : '';

  // so "haan yahi bhej do" next turn means the thing just recommended
  remember(ctx, [pick]);

  const name = withoutPack(pick.name);
  const price = rupeeLabel(pick.sellPaise);

  return speak(
    ctx,
    {
      kind: 'RECOMMEND',
      name,
      price,
      why,
      alternatives: displayNames(options.filter((o) => o.id !== pick.id).map((o) => o.name)),
    },
    copy.recommend(name, price, bought ? 'ye aap pehle bhi le chuke hain' : ''),
    card,
  );
}

/**
 * Everything in stock that plausibly answers a phrase, with no top-k cap.
 *
 * `rankLine` is the wrong tool for a listing question: it exists to pick
 * ONE thing and caps its shortlist at three, so "daal kaunsi kaunsi hai"
 * would drop the fourth dal for no reason a customer could understand.
 */
function matching(span: string, catalog: Sku[], stock: Map<string, number>): Sku[] {
  const q = stripQuantity(span);

  /**
   * SCORED NAME-INTO-SENTENCE, not sentence-into-names.
   *
   * fuzzyScore measures how much of its FIRST argument is accounted for
   * by its second, and the direction decides everything here. Asking how
   * much of "moong dal ka price kitna h" is covered by a product punishes
   * the question for being a question: four of its six words are grammar,
   * Moong Dal scored 0.33, nothing cleared the floor, and the shop read
   * out its category list instead of a price.
   *
   * The question worth asking is the other one -- does this product's
   * name appear IN what they said. Each name and alias is scored
   * separately and the best one wins, because "moong dal" matching
   * perfectly should not be dragged down by nine other aliases that do
   * not appear.
   */
  const scored = catalog
    .filter((s) => (stock.get(s.id) ?? 0) > 0)
    .map((s) => {
      const names = [s.name, ...s.aliases].filter(Boolean);
      let score = 0;
      let specific = 0;
      for (const n of names) {
        const hit = fuzzyScore(n, q);
        if (hit < LISTING_FLOOR) continue;
        const words = n.split(/\s+/).filter((w) => w.length >= 3).length;
        // a longer name that still matches is a more particular claim
        if (hit > score || (hit === score && words > specific)) {
          score = Math.max(score, hit);
          specific = Math.max(specific, words);
        }
      }
      return { s, score, specific };
    })
    .filter((x) => x.score >= LISTING_FLOOR)
    .sort((a, b) => b.specific - a.specific || b.score - a.score);

  /**
   * THE MOST PARTICULAR MATCH WINS OUTRIGHT.
   *
   * Every dal in the catalogue carries the alias "dal", so "moong dal ka
   * price kitna h" matched Moong, Toor and Chana equally at 1.00 and the
   * shop answered a price question by listing three dals. "moong dal" is
   * two words and both are in the sentence; "dal" is one. The longer
   * name is a stronger claim on what they meant, and when exactly one
   * SKU makes it, that is the answer rather than the shortlist.
   */
  const best = scored[0];
  if (best && (!scored[1] || scored[1].specific < best.specific)) return [best.s];

  return scored.slice(0, 8).map((x) => x.s);
}

/**
 * Are they asking what it COSTS, rather than what there is.
 *
 * A closed set of words, matched whole, and it stays a list rather than
 * a model call for the same reason the yes/no vocabulary does: the
 * failure mode of asking a model is that it answers the question you
 * asked instead of the one you meant, and here a wrong answer means
 * reciting the catalogue at someone who wanted a number.
 */
const PRICE_WORDS = new Set([
  'rate', 'price', 'daam', 'dam', 'kimat', 'keemat', 'bhav', 'cost', 'mrp',
]);

function asksPrice(text: string): boolean {
  return text.toLowerCase().split(/[^a-z]+/).some((w) => PRICE_WORDS.has(w));
}

/** high, because a list is a claim about everything the shop has */
const LISTING_FLOOR = 0.45;

/** how many times the shop may ask about one line before deciding */
const MAX_ASKS = 2;

/**
 * What the shop sells, in words a customer would use.
 *
 * Derived from the catalogue's own category slugs rather than a written
 * list, so a shop that adds a category gets it here without anyone
 * remembering to update a constant.
 */
function categoriesOf(catalog: Sku[], stock: Map<string, number>): string[] {
  const seen = new Set<string>();
  for (const s of catalog) {
    if ((stock.get(s.id) ?? 0) <= 0 || !s.category) continue;
    seen.add(s.category.replace(/[_-]+/g, ' '));
  }
  return [...seen].slice(0, 14);
}

async function repeatLast(ctx: Ctx): Promise<OutboundMessage[]> {
  const last = await prisma.order.findFirst({
    where: { householdId: ctx.householdId, status: { in: ['CONFIRMED', 'FULFILLED'] } },
    orderBy: { createdAt: 'desc' },
    include: { lines: { include: { sku: true } } },
  });

  if (!last?.lines.length) {
    return speak(ctx, { kind: 'NO_PREVIOUS_ORDER' }, copy.NO_PREVIOUS_ORDER);
  }

  const lines: PendingLine[] = last.lines
    .filter((l) => l.sku)
    .map((l) => ({
      sourceText: l.sourceText,
      quantity: l.quantity,
      unitHint: l.unitHint,
      skuId: l.skuId,
      name: l.sku!.name,
      // repriced from today's catalogue, not copied from the old row
      unitPricePaise: l.sku!.sellPaise,
      method: 'PRIOR',
      confidence: 1,
      wasSubstituted: false,
      alternates: [],
      needsDisambiguation: false,
    }));

  return placeOrder(ctx, lines, false);
}

async function account(ctx: Ctx): Promise<OutboundMessage[]> {
  const where = {
    householdId: ctx.householdId,
    status: { in: ['CONFIRMED' as const, 'FULFILLED' as const] },
  };
  const [orders, spend] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.aggregate({ where, _sum: { totalPaise: true } }),
  ]);
  const spent = rupeeLabel(spend._sum?.totalPaise ?? 0);

  return speak(ctx, { kind: 'ACCOUNT', orders, spent }, copy.account(orders, spent));
}

// ---------------------------------------------------------------- ordering

/**
 * Ask about the next unsettled line, or write the order if there are none.
 *
 * This replaced a one-liner that found the FIRST uncertain line, asked
 * about it, and returned -- silently discarding every other line in the
 * order. Ask about three things, get a question about one, and the other
 * two are gone. Now the whole set is carried in the pending context and the
 * questions are asked one at a time until they run out.
 */
async function advance(
  ctx: Ctx,
  lines: PendingLine[],
  amended: boolean,
  substituted: Swap[] = [],
  packAsks: PackAsk[] = [],
): Promise<OutboundMessage[]> {
  const index = lines.findIndex((l) => l.needsDisambiguation);

  if (index >= 0) {
    const line = lines[index]!;

    /**
     * GIVE UP ASKING BEFORE THE CUSTOMER GIVES UP ANSWERING.
     *
     * Two attempts, then take the best candidate and carry on. A question
     * nobody can answer, asked forever, is worse than a reasonable guess
     * -- and a guess is safe now, because rejecting an item works at any
     * point rather than only at checkout.
     */
    line.asks = (line.asks ?? 0) + 1;
    if (line.asks > MAX_ASKS) {
      line.needsDisambiguation = false;
      if (!line.skuId && line.alternates[0]) {
        line.skuId = line.alternates[0].skuId;
        line.name = line.alternates[0].name;
      }
      return advance(ctx, lines, amended, substituted, packAsks);
    }

    /**
     * DEDUPED, and it is not tidiness.
     *
     * The stock-out swap moves the original into `alternates` while the
     * substitute may already be sitting there, so the list came out as
     * "Dhara Mustard Oil 1L, Fortune Sunflower Oil 1L, Dhara Mustard Oil
     * 1L". Two identical names have a score gap of zero, the name matcher
     * calls that ambiguous and returns nothing, the reply falls through as
     * a NEW ORDER -- and a five item shopping list became one bottle of
     * mustard oil. One duplicate, four lines gone.
     */
    const seen = new Set<string>();
    const options = [
      ...(line.skuId ? [{ skuId: line.skuId, name: line.name }] : []),
      ...line.alternates.map((a) => ({ skuId: a.skuId, name: a.name })),
    ].filter((o) => !seen.has(o.skuId) && seen.add(o.skuId));

    /**
     * ONE OPTION IS NOT A CHOICE.
     *
     * "Moong Dal 1kg mein se kaunsa? Moong Dal" is a question with a
     * single answer, and asking it makes the shop look broken in a way
     * that no customer can help with. If the shortlist came down to one
     * thing, that is the answer.
     */
    if (options.length === 1 && line.skuId) {
      line.needsDisambiguation = false;
      return advance(ctx, lines, amended, substituted, packAsks);
    }

    // Nothing to offer means nothing to ask. Drop the line rather than
    // send a question with an empty option list.
    if (!options.length) {
      line.needsDisambiguation = false;
      line.skuId = null;
      return advance(ctx, lines, amended, substituted, packAsks);
    }

    ctx.convo.pending = {
      kind: 'DISAMBIGUATE',
      lines, index, options, meta: ctx.meta,
      askedAt: new Date().toISOString(),
    };

    /**
     * The stored options keep their FULL names -- that is what the answer
     * is matched against and what prices the line. Only the SPOKEN list is
     * shortened. See displayNames in resolver/pack.ts.
     */
    const names = displayNames(options.map((o) => o.name));
    remember(ctx, options.map((o) => ({ id: o.skuId, name: o.name })));

    /**
     * TWO DIFFERENT QUESTIONS, and they should not sound alike.
     *
     * Clarifying is "chawal mein se kaunsa" -- the ranker found three and
     * cannot choose. Eliciting is "snacks mein ye ye hai" -- the ranker
     * found nothing and the shop is opening the shelf. MG-ShopDial keeps
     * them as separate agent intents; conflating them makes the shop sound
     * confused when it is being helpful.
     */
    return speak(
      ctx,
      line.elicitedCategory
        ? {
            kind: 'ELICIT',
            sourceText: line.sourceText,
            category: line.elicitedCategory,
            options: names,
          }
        : { kind: 'ASK_WHICH', sourceText: line.sourceText, options: names },
      copy.askWhich(line.sourceText, names),
    );
  }

  return placeOrder(ctx, lines, amended, substituted, packAsks);
}

/**
 * Writes the Order at AWAITING and asks whether to send it.
 *
 * The row is written HERE and not before, because until the questions are
 * answered there is no order -- only a conversation. Half-finished ones
 * used to be persisted anyway and then counted in the shop's pending total.
 */
async function placeOrder(
  ctx: Ctx,
  lines: PendingLine[],
  amended: boolean,
  substituted: Swap[] = [],
  packAsks: PackAsk[] = [],
): Promise<OutboundMessage[]> {
  const kept = lines.filter((l) => l.skuId);

  /**
   * SAY WHAT DID NOT MAKE IT.
   *
   * A line the shop could not match was dropped in silence: a five item
   * list came back as a four item card and nothing anywhere mentioned the
   * fifth. The customer wrote it down, so they will notice it missing when
   * the bag arrives, which is the worst possible moment.
   */
  const dropped = lines.filter((l) => !l.skuId).map((l) => l.sourceText);

  if (!kept.length && !ctx.convo.basket.length) {
    ctx.convo.pending = null;
    return speak(ctx, { kind: 'NOT_UNDERSTOOD' }, copy.NOT_UNDERSTOOD);
  }

  /**
   * INTO THE BASKET, NOT INTO THE DATABASE.
   *
   * This used to write an Order row here and immediately ask "bhej dun?",
   * which turned every single item into a checkout. Adding a second thing
   * then CANCELLED that order and wrote another, so a three item
   * conversation left two cancelled rows behind and the shopkeeper's
   * dashboard filled with orders nobody had placed.
   *
   * A counter does not work like that. Things go in the bag, the customer
   * asks what sugar costs, more things go in the bag, and the bill is
   * added up once at the end. Nothing is written until they say send it.
   */
  ctx.convo.basket = mergeBasket(ctx.convo.basket, kept);
  ctx.convo.pending = null;

  /**
   * "YEH" MEANS WHAT WE ARE TALKING ABOUT NOW.
   *
   * remember() used to be called only where the shop ANSWERED something,
   * so the referent was pinned to the last thing ASKED about and never
   * moved when the conversation did:
   *
   *   moong dal ka price kitna h   yeh -> Moong Dal
   *   do kilo atta bhej do         yeh -> Moong Dal   <- topic moved, this did not
   *
   * Putting something in the basket is talking about it, and it is the
   * most recent thing said.
   */
  remember(ctx, kept.map((l) => ({ id: l.skuId!, name: l.name })));

  const added = kept.map((l) => withoutPack(l.name));

  return speak(
    ctx,
    { kind: 'BASKET_ADDED', added, substituted, packAsks, dropped },
    copy.addedToBasket(added, packAsks),
    copy.orderCard(ctx.convo.basket),
  );
}

/**
 * Fold new lines into the basket, keyed by SKU.
 *
 * A restated item REPLACES rather than stacks: someone who already has
 * two kilos of sugar in the bag and says "teen kilo chini" means three,
 * not five. Position is kept so the card does not reshuffle between
 * messages.
 */
function mergeBasket(basket: PendingLine[], fresh: PendingLine[]): PendingLine[] {
  const out = [...basket];
  for (const line of fresh) {
    const at = line.skuId ? out.findIndex((b) => b.skuId === line.skuId) : -1;
    if (at >= 0) out[at] = line;
    else out.push(line);
  }
  return out;
}

/**
 * Read the basket back and ask for the word that writes it down.
 *
 * The Order row still does not exist at this point. It is written in
 * `writeOrder`, once, after they say yes -- so an abandoned conversation
 * leaves nothing behind at all, rather than an AWAITING row the
 * shopkeeper has to guess about.
 */
async function checkout(ctx: Ctx): Promise<OutboundMessage[]> {
  if (!ctx.convo.basket.length) {
    return speak(ctx, { kind: 'BASKET_EMPTY' }, copy.BASKET_EMPTY);
  }

  /**
   * STRAIGHT TO THE ORDER. No "bhej dun?" in between.
   *
   * "isko pack kr do" IS the confirmation -- asking again is a turn spent
   * confirming a confirmation. What replaces that safety is the payment
   * gate: the order sits at PAYMENT_PENDING, no stock moves, and a
   * customer who changes their mind simply does not pay.
   */
  return writeOrder(ctx);
}

/**
 * Note what the shop just put in front of the customer, so a pointer in
 * their next message has something to point AT. Overwritten every time,
 * never accumulated -- see lastNamed in state.ts.
 */
function remember(ctx: Ctx, skus: Array<{ id: string; name: string }>): void {
  ctx.convo.lastNamed = skus.slice(0, 4).map((s) => ({ skuId: s.id, name: s.name }));
}

/** the one write, at the end, with everything in it */
async function writeOrder(ctx: Ctx): Promise<OutboundMessage[]> {
  const lines = ctx.convo.basket;
  const total = lines.reduce((sum, l) => sum + l.unitPricePaise * l.quantity, 0);

  /**
   * THE ID IS MINTED HERE, so the row and the payment link can be made at
   * the same time.
   *
   * These were sequential for the obvious reason -- Razorpay needs a
   * reference and the reference was the row's id, so the row had to exist
   * first. Measured at 1561ms for the write and 1488ms for the link, back
   * to back, in the one turn where the customer is most likely to be
   * watching: the one where they are about to pay.
   *
   * Nothing about a cuid requires a database to produce it. Generating it
   * up front makes the two independent, and checkout costs the slower of
   * them instead of the sum.
   *
   * IF THE WRITE FAILS after the link was created, the link is orphaned.
   * That is the right way round: an unpaid link nobody has seen expires
   * on its own, and settle.ts looks orders up by id, so a webhook for a
   * row that does not exist finds nothing and does nothing. The reverse
   * -- a row with no way to pay it -- is the case that needs a human.
   */
  // any unique string is a valid id here; the schema's cuid() default only
  // applies when one is not supplied
  const orderId = randomUUID();

  const [order, rzp] = await Promise.all([
    span('db.order.create', () => prisma.order.create({
    data: {
      id: orderId,
      kiranaId: ctx.kiranaId,
      householdId: ctx.householdId,
      // straight to CONFIRMED: the customer just said so, and there is no
      // intermediate state left for an AWAITING row to represent
      // frozen, not committed: see the note in writeOrder
      status: 'PAYMENT_PENDING',
      paymentStatus: 'PENDING',
      source: ctx.meta.source,
      rawText: ctx.meta.rawText,
      transcript: ctx.meta.transcript,
      asrEngine: ctx.meta.asrEngine,
      mediaPath: ctx.meta.mediaPath,
      latencyMs: Date.now() - ctx.meta.startedAt,
      totalPaise: Math.round(total),
      lines: {
        create: lines.map((l) => ({
          skuId: l.skuId,
          sourceText: l.sourceText,
          quantity: l.quantity,
          unitHint: l.unitHint,
          unitPricePaise: l.unitPricePaise,
          linePaise: Math.round(l.unitPricePaise * l.quantity),
          method: l.method as never,
          confidence: l.confidence,
          wasSubstituted: l.wasSubstituted,
          alternatesJson: l.alternates as never,
        })),
      },
    },
  })),
    span('rzp.link', () => razorpayLinkFor(ctx, orderId, Math.round(total))),
  ]);

  /**
   * The invoice row, which the webhook reconciles through, written once
   * the order it points at exists. Awaited on purpose: a customer who
   * has paid against a link with no invoice row is a payment that never
   * settles, and that is not a risk worth 200ms.
   */
  const link = rzp
    ? await span('db.invoice', async () => {
        try {
          await recordInvoice(
            orderId,
            { kiranaId: ctx.kiranaId, householdId: ctx.householdId },
            linkArgsFor(ctx, orderId, Math.round(total)),
            rzp,
          );
          return rzp.shortUrl;
        } catch {
          // no row means no reconciliation, so do not offer the link
          return null;
        }
      })
    : null;

  ctx.convo.pending = null;

  /**
   * THE CART IS FROZEN, NOT COMMITTED.
   *
   * The order exists at PAYMENT_PENDING and the goods have NOT moved --
   * stock comes down in payments/settle.ts when money actually lands.
   * Decrementing here would let anyone empty a shop's shelf by starting
   * checkouts they never pay for.
   *
   * The basket is kept for the same reason: a customer who does not pay
   * still has their shopping when they come back.
   */

  /**
   * The link and the total are appended by CODE, like every other figure
   * a customer reads. The model is told one is coming and never sees the
   * URL -- a mistyped payment link is not a cosmetic error.
   */
  return speak(
    ctx,
    { kind: 'AWAITING_PAYMENT', ref: order.id.slice(-6), link },
    copy.awaitingPayment(order.totalPaise, link),
    copy.paymentSlip(order.totalPaise, link, order.id.slice(-6)),
  );
}

/**
 * A Razorpay link for this order, or null if Razorpay is unreachable.
 *
 * Never fatal. An order the customer cannot pay online is an order they
 * pay at the door, which is how most of these are paid anyway -- losing
 * the whole checkout because a payment provider timed out would be a
 * far worse trade.
 */
function linkArgsFor(ctx: Ctx, orderId: string, amountPaise: number) {
  return {
    amountPaise,
    description: `Order #${orderId.slice(-6)}`,
    customerName: ctx.buyerName,
    customerPhone: ctx.buyerPhone,
  };
}

/**
 * Ask Razorpay for a link. Nothing is written here, so this can run
 * before the order row exists -- see the note in payments/razorpay.ts.
 */
async function razorpayLinkFor(
  ctx: Ctx, orderId: string, amountPaise: number,
): Promise<RazorpayLink | null> {
  try {
    return await createRazorpayLink(orderId, linkArgsFor(ctx, orderId, amountPaise));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- answering

/**
 * Reads what they said as the answer to whatever is outstanding.
 *
 * Returns null when it is not an answer at all, which is the signal to the
 * caller to read the message as a new instruction instead. That is the
 * whole escape hatch, and it is why the vocabulary in ./reply.ts can stay
 * short.
 */
async function answer(ctx: Ctx, pending: Pending): Promise<OutboundMessage[] | null> {
  if (pending.kind === 'CHECKOUT') {
    const a = readAnswer(ctx.said, 3);

    /**
     * ANNOTATED HERE, not by the extractor, because this path never calls
     * it -- and answers are a large share of any real conversation. Left
     * unlabelled, "haan bhej do" stored null/null and the goal timeline
     * had holes exactly where the customer was agreeing to things.
     *
     * Deterministic, and better for it: the system already knows how it
     * read the reply, so asking a model to classify it again could only
     * introduce disagreement with the action actually taken.
     */
    ctx.annotation = {
      intent:
        a.kind === 'YES' || (a.kind === 'CHOICE' && a.index === 0)
          ? 'POSITIVE_FEEDBACK'
          : a.kind === 'UNKNOWN'
            ? 'DISCLOSE'
            : 'NEGATIVE_FEEDBACK',
      goal: 'ORDERING',
    };

    const yes = a.kind === 'YES' || (a.kind === 'CHOICE' && a.index === 0);
    const change = a.kind === 'CHANGE' || (a.kind === 'CHOICE' && a.index === 1);
    const no = a.kind === 'NO' || (a.kind === 'CHOICE' && a.index === 2);

    if (yes) return writeOrder(ctx);

    if (no) {
      /**
       * A NO THAT NAMES A PRODUCT IS A REJECTION, NOT A CANCELLATION.
       *
       * "chini nahi chahiye" and "nahi rehne do" both contain nahi, and
       * both used to wipe the whole basket. MG-ShopDial keeps Negative
       * feedback separate from ending the conversation for exactly this
       * reason, and reports it as the highest-agreement intent in the
       * schema -- people are unambiguous when they reject a suggestion.
       *
       * The test is whether they named something in the basket. If they
       * did, that item comes out and the rest stays.
       */
      const dropped = dropFromBasket(ctx);
      if (dropped) return dropped;

      ctx.convo.basket = [];
      ctx.convo.pending = null;
      return speak(ctx, { kind: 'ORDER_CANCELLED' }, copy.CANCELLED);
    }

    if (change) {
      /**
       * They want to change something but have not said what. The basket
       * is KEPT -- that is the whole difference from before, when there
       * was an order row to cancel and cancelling it was the only option.
       * Now the shop can simply ask, and nothing is lost either way.
       */
      ctx.convo.pending = null;
      return speak(
        ctx,
        { kind: 'ORDER_REPLACED' },
        copy.SEND_AGAIN,
        copy.orderCard(ctx.convo.basket),
      );
    }

    return null;
  }

  // ---- disambiguation --------------------------------------------------
  const catalog = await getCatalog(ctx.kiranaId);
  const offered = pending.options
    .map((o) => catalog.find((s) => s.id === o.skuId))
    .filter((s): s is Sku => Boolean(s));

  /**
   * A tapped digit, or the NAME of one of the things offered.
   *
   * The name half is pickFrom -- the same scorer as everything else,
   * pointed at just these few SKUs. It used to be readChoiceByName, a
   * separate matcher with its own margin rule, which is why "Basmati Rice
   * 5kg" read as ambiguous against "India Gate Basmati Rice 5kg" and the
   * shop asked the same question five times running.
   */
  const a = readAnswer(ctx.said, pending.options.length);
  const byName = a.kind === 'UNKNOWN' ? pickFrom(ctx.said, offered) : null;
  const choice =
    a.kind === 'CHOICE' ? a.index : byName !== null ? byName : null;

  ctx.annotation = {
    intent: a.kind === 'NONE_OF_THESE' ? 'NEGATIVE_FEEDBACK' : 'ANSWER',
    // answering which of several products you meant IS preference
    // disclosure, which the paper files under recommendation
    goal: pending.lines[pending.index]?.elicitedCategory ? 'RECOMMENDATION' : 'ORDERING',
  };

  if (choice === null && a.kind !== 'NONE_OF_THESE') return null;

  const lines = pending.lines;
  const line = lines[pending.index]!;
  const packAsks: PackAsk[] = [];

  if (choice !== null) {
    const picked = pending.options[choice]!;
    const sku = catalog.find((s) => s.id === picked.skuId);
    line.skuId = picked.skuId;
    line.name = picked.name;
    line.unitPricePaise = sku?.sellPaise ?? line.unitPricePaise;
    // the buyer chose it, so the confidence is theirs and not the ranker's
    line.method = 'DISAMBIGUATED';
    line.confidence = 1;
    // the SKU is final now, so the amount can finally be turned into packs
    if (sku) {
      const ask = applyPack(line, sku);
      if (ask) packAsks.push(ask);
    }
  } else {
    // the trailing "koi nahi": drop the line entirely
    line.skuId = null;
  }
  line.needsDisambiguation = false;

  // meta comes from the pending context, not from this turn: the order
  // belongs to the voice note that started it, not to the word "basmati"
  ctx.meta = pending.meta;
  return advance(ctx, lines, false, [], packAsks);
}

// ---------------------------------------------------------------- upkeep

/**
 * Take out of the basket whatever they just refused.
 *
 * Returns null when no item in the basket was named, which means the no
 * was about the whole thing and the caller should empty it.
 *
 * Much smaller than it used to be. When an Order row existed at this
 * point the same job meant cancelling that row, rebuilding every
 * surviving line by hand and writing a replacement; with a basket it is
 * a splice.
 */
function dropFromBasket(ctx: Ctx, named?: string): Promise<OutboundMessage[]> | null {
  const basket = ctx.convo.basket;
  /**
   * The same scorer again, pointed at the basket. This was namesLine, a
   * third matcher with a fourth notion of what counts as a match.
   *
   * Matched against what the POLICY layer says they named, when it says
   * anything: "sugar hata do" arrives as productQuery "sugar" with the
   * command already stripped, so "hata do" never reaches the matcher.
   */
  const at = pickFrom(named ?? ctx.said, basket.map((l) => ({
    id: l.skuId!, kiranaId: ctx.kiranaId, name: l.name, brand: null,
    packSize: 1, unit: 'pc', sellPaise: l.unitPricePaise, category: null, aliases: [],
  })));
  if (at === null) return null;

  const [gone] = basket.splice(at, 1);
  ctx.convo.pending = null;

  if (!basket.length) {
    return speak(ctx, { kind: 'ORDER_CANCELLED' }, copy.CANCELLED);
  }

  return speak(
    ctx,
    { kind: 'REJECTED', rejected: withoutPack(gone!.name), options: [] },
    copy.rejected(withoutPack(gone!.name)),
    copy.orderCard(basket),
  );
}

/**
 * Retire a question nobody answered, and the basket it belonged to.
 *
 * There is no order row to cancel any more -- that is the point of the
 * basket, and it used to be the whole body of this function. What is
 * left is emptying a bag somebody walked away from six hours ago, so
 * tomorrow's "bhej do" does not send yesterday's shopping.
 */
function expire(ctx: Ctx): void {
  ctx.convo.pending = null;
  ctx.convo.basket = [];
}

function reAsk(ctx: Ctx, pending: Pending): Promise<OutboundMessage[]> {
  if (pending.kind === 'DISAMBIGUATE') {
    const line = pending.lines[pending.index]!;
    const names = displayNames(pending.options.map((o) => o.name));
    return speak(
      ctx,
      { kind: 'ASK_WHICH', sourceText: line.sourceText, options: names },
      copy.askWhich(line.sourceText, names),
    );
  }
  return speak(ctx, { kind: 'STILL_WAITING' }, copy.STILL_WAITING);
}
