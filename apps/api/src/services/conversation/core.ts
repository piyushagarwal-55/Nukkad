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
import { fitPack } from '../resolver/pack.js';
import { findSubstitutes } from '../substitution/substitute.js';
import { hasVision } from '../../config/env.js';
import { readAnswer, namesLine } from './reply.js';
import { compose, type Facts, type Swap, type PackAsk } from './compose.js';
import { retrieveKb } from '../kb/retrieve.js';
import type { Prior } from '../resolver/prior.js';
import {
  loadConvo, save, flatten, isStale,
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

/** Twilio's shared sandbox sender. Identifies no particular shop. */
const SANDBOX_NUMBER = '+14155238886';

/** everything a handler needs, so signatures stay readable */
interface Ctx {
  convo: Convo;
  kiranaId: string;
  householdId: string;
  buyerName: string;
  shopName: string;
  /** what the buyer sent this turn, so the voice can mirror their register */
  said: string;
  meta: OrderMeta;
  /** filled in once the extractor has read this turn. See handle(). */
  annotation?: { intent: string; goal: string };
}

/** say something true, in the customer's own words */
async function speak(
  ctx: Pick<Ctx, 'convo' | 'buyerName' | 'shopName' | 'said'>,
  facts: Facts,
  fallback: string,
  card?: string,
): Promise<OutboundMessage[]> {
  const text = await compose({
    facts,
    said: ctx.said,
    buyerName: ctx.buyerName,
    shopName: ctx.shopName,
    recent: ctx.convo.recent,
    card,
    fallback,
  });
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
      return { intent: 'RECOMMEND', goal: 'ORDERING' };
    case 'ORDER_CONFIRMED':
      return { intent: 'POSITIVE_FEEDBACK', goal: 'ORDERING' };
    case 'ORDER_CANCELLED':
    case 'ORDER_REPLACED':
      return { intent: 'INTERACTION_STRUCTURING', goal: 'ORDERING' };
    case 'ASK_WHICH':
      return { intent: 'CLARIFICATION_QUESTION', goal: 'ORDERING' };
    case 'ELICIT':
      return { intent: 'ELICIT_PREFERENCES', goal: 'RECOMMENDATION' };
    case 'REJECTED':
      return { intent: 'RECOMMEND', goal: 'RECOMMENDATION' };
    case 'STILL_WAITING':
      return { intent: 'CLARIFICATION_QUESTION', goal: 'ORDERING' };
    case 'STOCK_ANSWER':
    case 'LISTING':
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

export async function handle(msg: InboundMessage): Promise<OutboundMessage[]> {
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
  let kirana = await prisma.kirana.findFirst({
    where: { OR: [{ whatsappNumber: msg.recipientId }, { phone: msg.recipientId }] },
  });

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
    const known = await prisma.household.findFirst({
      where: { phone: msg.senderId },
      include: { kirana: true },
    });
    kirana = known?.kirana ?? null;
  }

  if (!kirana) {
    // Nothing registered on this number, so we cannot know whose catalogue
    // to answer from. Stay silent rather than guess wrong.
    return [];
  }

  const household = await prisma.household.findUnique({
    where: { kiranaId_phone: { kiranaId: kirana.id, phone: msg.senderId } },
  });

  if (!household) {
    // No conversation row for an unknown number, so this one reply is
    // composed without any history to draw on.
    return speak(
      { convo: { id: '', pending: null, recent: [] }, buyerName: 'ji', shopName: kirana.name, said: msg.text ?? '' },
      { kind: 'NOT_REGISTERED' },
      copy.NOT_REGISTERED,
    );
  }

  const convo = await loadConvo(msg.channel, msg.senderId, household.id, kirana.id);

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
    shopName: kirana.name,
    said: text,
    meta: {
      source: audio ? 'VOICE' : 'TEXT',
      rawText: msg.text ?? null,
      transcript,
      asrEngine,
      mediaPath: audio?.localPath ?? null,
      startedAt: started,
    },
  };

  const out = await turn(ctx, msg);

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
  if (ctx.annotation) {
    await prisma.message.updateMany({
      where: { externalId: msg.externalId },
      data: ctx.annotation,
    });
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
  await save(convo);

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
    await expire(pending);
    pending = ctx.convo.pending = null;
  }

  if (!ctx.said.trim()) {
    // An empty message cannot answer a question, so re-ask rather than
    // drop whatever was outstanding.
    if (pending) return reAsk(ctx, pending);
    return speak(ctx, { kind: 'GREETING' }, copy.GREETING);
  }

  /**
   * Lines carried over from an order the customer is amending rather than
   * replacing. Empty in every other case.
   */
  let carried: PendingLine[] = [];

  if (pending) {
    const answered = await answer(ctx, pending);
    // null means "this was not an answer" -- fall through and read it as
    // a new instruction, which is nearly always what the customer meant
    if (answered) return answered;

    /**
     * AMENDING, NOT STARTING OVER.
     *
     * A customer looking at a card that says "2 x atta" who types "aur ek
     * kilo chini bhi" has said ALSO. Reading that as a fresh order gives
     * them two orders -- one holding the atta they still want, one holding
     * the sugar -- and leaves the first sitting in the shop's pending list
     * as work nobody will ever pack. Measured, that is exactly what
     * happened before this block existed.
     *
     * So the old order is superseded and its lines come forward. Removal
     * is NOT handled here on purpose: "chini hata do" contains hata, which
     * ./reply.ts reads as CHANGE, and that path cancels and asks for the
     * whole list again. Adding is common and cheap to get right; removing
     * by natural language is neither.
     */
    if (pending.kind === 'CONFIRM') carried = await supersede(pending.orderId);

    /**
     * The same courtesy for an unanswered QUESTION. A reply the matcher
     * cannot read is usually the customer adding something, not throwing
     * their list away -- and when it was read wrongly, as it was above,
     * the cost of discarding was four lines of a five line order.
     *
     * Only the SETTLED lines come forward. The one still under question
     * is dropped, because carrying an unanswered question into a fresh
     * turn would ask it again forever.
     */
    if (pending.kind === 'DISAMBIGUATE') {
      carried = pending.lines.filter((l) => l.skuId && !l.needsDisambiguation);
    }

    ctx.convo.pending = null;
  }

  return act(ctx, carried);
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
  return act(ctx, [], list.items);
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
  carried: PendingLine[],
  /**
   * Items already read off a photographed list. When present the text
   * extractor is skipped -- there is no text to extract from, and the
   * picture has already said what it says.
   */
  fromPhoto?: Extraction['items'],
): Promise<OutboundMessage[]> {
  const extraction: Extraction = fromPhoto
    ? { items: fromPhoto, intent: 'ORDER', goal: 'ORDERING' }
    : await extractOrder(ctx.said);
  ctx.annotation = {
    // DISCLOSE is the paper's name for a customer stating what they want,
    // and a photographed list is the purest form of it
    intent: fromPhoto ? 'DISCLOSE' : extraction.intent,
    goal: extraction.goal,
  };

  switch (extraction.intent) {
    case 'CANCEL':
      if (carried.length) {
        // they were mid-order and changed their mind about all of it
        return speak(ctx, { kind: 'ORDER_CANCELLED' }, copy.CANCELLED);
      }
      return speak(ctx, { kind: 'ORDER_CANCELLED' }, copy.CANCELLED);

    case 'REPEAT':
      return repeatLast(ctx);

    case 'ACCOUNT':
      return account(ctx);

    case 'GREETING':
      if (carried.length) return placeOrder(ctx, carried, true);
      return speak(ctx, { kind: 'GREETING' }, copy.GREETING);

    case 'QUESTION':
      return question(ctx, extraction.items.map((i) => i.text), carried);

    default:
      break;
  }

  if (!extraction.items.length) {
    // Anything carried from a superseded order is put back rather than
    // dropped: failing to parse the amendment is no reason to lose what
    // the customer had already agreed to.
    if (carried.length) return placeOrder(ctx, carried, true);
    /**
     * "ghar ka rashan chahiye" is a real request that names no product.
     * Answering it with "samajh nahi aaya" is true and useless; the shop
     * knows exactly what it sells and can just say so.
     */
    const [cat, st] = await Promise.all([getCatalog(ctx.kiranaId), getStockMap(ctx.kiranaId)]);
    const categories = categoriesOf(cat, st);
    return speak(ctx, { kind: 'CATALOGUE', categories }, copy.catalogue(categories));
  }

  // ---- rank against THIS shop's catalogue, with THIS household's prior
  const [catalog, stock, prior] = await Promise.all([
    getCatalog(ctx.kiranaId),
    getStockMap(ctx.kiranaId),
    buildPrior(ctx.householdId),
  ]);

  const resolved: ResolvedLine[] = extraction.items.map((it) =>
    rankLine(it.text, it.quantity, it.unit, catalog, prior, DEFAULT_RANK),
  );

  /**
   * WHAT THEY ASKED FOR IS NOT ALWAYS HOW IT IS SOLD.
   *
   * Until this ran, every quantity was treated as a count of packets
   * whatever unit the customer used, so "Tea 500 g" ordered 250 packets of
   * 500g. See resolver/pack.ts. A request that does not divide into whole
   * packets is not rounded silently -- it is collected here and asked
   * about on the card.
   */
  const mismatched: PackAsk[] = [];
  for (const line of resolved) {
    /**
     * Fitted only when the SKU is FINAL. A line still going to the buyer
     * as a question has no pack size yet -- "Rice 5 kg" could become a 5kg
     * bag or a 1kg one, and fitting against a guess then re-fitting against
     * the answer double-converts: 5 kg became 1 packet became 1 kg. It
     * shipped as "5 x Basmati Rice 5kg", twenty-five kilos of rice.
     *
     * So each line is fitted exactly once, at the moment its SKU settles.
     * See the disambiguation branch of answer() for the other half.
     */
    if (!line.chosen || line.needsDisambiguation) continue;
    const ask = applyPack(line, line.chosen.sku);
    if (ask) mismatched.push(ask);
  }

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
        sku, score: 0, fuzzy: 0, method: 'UNRESOLVED' as const,
      }));
      lost.needsDisambiguation = true;
      elicitedCategory = opened.category;
    }
  }

  const lines = merge(carried, resolved.map(flatten));
  if (elicitedCategory && lost) {
    /**
     * Marked on the LINE rather than held in a module-level map, because
     * the question can outlive the turn: a customer who ignores it and
     * comes back an hour later must be re-asked the same way.
     */
    const at = lines.find((l) => l.sourceText === lost.sourceText);
    if (at) at.elicitedCategory = elicitedCategory;
  }

  return advance(ctx, lines, carried.length > 0, substituted, mismatched);
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
async function question(
  ctx: Ctx,
  spans: string[],
  carried: PendingLine[],
): Promise<OutboundMessage[]> {
  const card = carried.length ? copy.orderCard(carried) : undefined;

  const [catalog, stock, prior] = await Promise.all([
    getCatalog(ctx.kiranaId),
    getStockMap(ctx.kiranaId),
    buildPrior(ctx.householdId),
  ]);

  if (spans.length) {
    const line = rankLine(spans[0]!, 1, null, catalog, prior, DEFAULT_RANK);

    if (line.chosen && !line.needsDisambiguation) {
      const sku = line.chosen.sku;
      return speak(ctx, {
        kind: 'STOCK_ANSWER',
        name: sku.name,
        inStock: (stock.get(sku.id) ?? 0) > 0,
        price: rupeeLabel(sku.sellPaise),
      }, copy.stockAnswer(sku.name, (stock.get(sku.id) ?? 0) > 0), card);
    }

    /**
     * AMBIGUITY IS THE ANSWER TO A LISTING QUESTION.
     *
     * The old shape here was `if (confident) answer; else deflect`, which
     * got it exactly backwards. Asked "daal kaunsi kaunsi hai" the ranker
     * matched four dals, could not choose between them, and the shop
     * replied "main confirm kar leta hoon" -- about a question whose whole
     * answer was those four names, sitting in the catalogue it had just
     * searched.
     *
     * MG-ShopDial names this a LISTING question and files it under QA
     * alongside factoid and yes/no. It is the one of the three this shop
     * could not do.
     */
    const found = matching(spans[0]!, catalog, stock);
    if (found.length) {
      return speak(
        ctx,
        { kind: 'LISTING', asked: spans[0]!, options: found.map((s) => s.name) },
        copy.listing(found.map((s) => s.name)),
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
 * Everything in stock that plausibly answers a phrase, with no top-k cap.
 *
 * `rankLine` is the wrong tool for a listing question: it exists to pick
 * ONE thing and caps its shortlist at three, so "daal kaunsi kaunsi hai"
 * would drop the fourth dal for no reason a customer could understand.
 */
function matching(span: string, catalog: Sku[], stock: Map<string, number>): Sku[] {
  const q = stripQuantity(span);
  return catalog
    .filter((s) => (stock.get(s.id) ?? 0) > 0)
    .map((s) => ({ s, score: fuzzyScore(q, [s.name, s.brand ?? '', ...s.aliases].join(' ')) }))
    .filter((x) => x.score >= LISTING_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.s);
}

/** high, because a list is a claim about everything the shop has */
const LISTING_FLOOR = 0.45;

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
 * Fold an amendment into the order it amends, keyed by SKU.
 *
 * A restated item REPLACES rather than stacks: someone who says "nahi teen
 * kilo atta" while two kilos are on the card means three, not five. A new
 * item is appended. Carried lines keep their position so the card does not
 * reshuffle under the customer between one message and the next.
 */
function merge(carried: PendingLine[], fresh: PendingLine[]): PendingLine[] {
  if (!carried.length) return fresh;

  const out = [...carried];
  for (const line of fresh) {
    const at = line.skuId ? out.findIndex((c) => c.skuId === line.skuId) : -1;
    if (at >= 0) out[at] = line;
    else out.push(line);
  }
  return out;
}

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

    const names = options.map((o) => o.name);

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

  if (!kept.length) {
    ctx.convo.pending = null;
    return speak(ctx, { kind: 'NOT_UNDERSTOOD' }, copy.NOT_UNDERSTOOD);
  }

  const total = kept.reduce((sum, l) => sum + l.unitPricePaise * l.quantity, 0);

  const order = await prisma.order.create({
    data: {
      kiranaId: ctx.kiranaId,
      householdId: ctx.householdId,
      status: 'AWAITING',
      source: ctx.meta.source,
      rawText: ctx.meta.rawText,
      transcript: ctx.meta.transcript,
      asrEngine: ctx.meta.asrEngine,
      mediaPath: ctx.meta.mediaPath,
      latencyMs: Date.now() - ctx.meta.startedAt,
      totalPaise: Math.round(total),
      lines: {
        create: kept.map((l) => ({
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
  });

  ctx.convo.pending = {
    kind: 'CONFIRM', orderId: order.id, askedAt: new Date().toISOString(),
  };

  /**
   * The card is rendered by code and appended AFTER whatever the voice
   * says. Quantities, prices and the total never pass through a model,
   * here or anywhere else.
   */
  const card = `${copy.orderCard(kept)}\n(#${order.id.slice(-6)})`;

  return speak(
    ctx,
    amended
      ? { kind: 'ORDER_AMENDED' }
      : { kind: 'ORDER_DRAFT', substituted, packAsks, dropped },
    copy.readyToSend(packAsks),
    card,
  );
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
  if (pending.kind === 'CONFIRM') {
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

    if (yes) {
      const order = await prisma.order.update({
        where: { id: pending.orderId },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      });
      ctx.convo.pending = null;
      return speak(
        ctx,
        { kind: 'ORDER_CONFIRMED', ref: order.id.slice(-6) },
        copy.confirmed(order.totalPaise, order.id.slice(-6)),
      );
    }

    if (no) {
      /**
       * A NO THAT NAMES A PRODUCT IS A REJECTION, NOT A CANCELLATION.
       *
       * "dhara nahi chahiye" and "nahi rehne do" both contain nahi, and
       * until now both wiped the entire order. MG-ShopDial keeps Negative
       * feedback separate from ending the conversation for exactly this
       * reason, and reports it as the highest-agreement intent in the
       * schema -- people are unambiguous when they reject a suggestion.
       *
       * The test is whether they named something on the card. If they did,
       * that line is reopened and everything else survives. If they did
       * not, they meant the order.
       */
      const rejected = await rejectLine(ctx, pending.orderId);
      if (rejected) return rejected;

      await prisma.order.update({
        where: { id: pending.orderId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      ctx.convo.pending = null;
      return speak(ctx, { kind: 'ORDER_CANCELLED' }, copy.CANCELLED);
    }

    if (change) {
      /**
       * The pending order is cancelled rather than held open.
       *
       * Holding it would be friendlier and is the wrong trade here: an
       * AWAITING order nobody ever returns to is indistinguishable, in the
       * shop's dashboard, from one the shopkeeper still has to pack. A
       * cancelled one is honest about what happened.
       */
      await prisma.order.update({
        where: { id: pending.orderId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      ctx.convo.pending = null;
      return speak(ctx, { kind: 'ORDER_REPLACED' }, copy.SEND_AGAIN);
    }

    return null;
  }

  // ---- disambiguation --------------------------------------------------
  const names = pending.options.map((o) => o.name);
  const a = readAnswer(ctx.said, pending.options.length, names);

  ctx.annotation = {
    intent: a.kind === 'NONE_OF_THESE' ? 'NEGATIVE_FEEDBACK' : 'ANSWER',
    // answering which of several products you meant IS preference
    // disclosure, which the paper files under recommendation
    goal: pending.lines[pending.index]?.elicitedCategory ? 'RECOMMENDATION' : 'ORDERING',
  };

  if (a.kind !== 'CHOICE' && a.kind !== 'NONE_OF_THESE') return null;

  const lines = pending.lines;
  const line = lines[pending.index]!;
  const packAsks: PackAsk[] = [];

  if (a.kind === 'CHOICE') {
    const picked = pending.options[a.index]!;
    const catalog = await getCatalog(ctx.kiranaId);
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
 * Reopen one line of a pending order, if that is what they rejected.
 *
 * Returns null when no product on the card was named, which means the no
 * was about the order and the caller should cancel it.
 */
async function rejectLine(ctx: Ctx, orderId: string): Promise<OutboundMessage[] | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lines: { include: { sku: true } } },
  });
  if (!order || order.status !== 'AWAITING') return null;

  const named = order.lines.filter((l) => l.sku);
  const at = namesLine(ctx.said, named.map((l) => l.sku!.name));
  if (at === null) return null;

  const target = named[at]!;
  const [catalog, stock, prior] = await Promise.all([
    getCatalog(ctx.kiranaId),
    getStockMap(ctx.kiranaId),
    buildPrior(ctx.householdId),
  ]);

  // what else the shop could give them instead of the thing they refused
  const options = findSubstitutes(target.sku!, catalog, stock, prior)
    .map((c) => c.sku)
    .filter((s) => s.id !== target.skuId)
    .slice(0, 3);

  // the rest of the basket is untouched, which is the whole point
  const survivors: PendingLine[] = named
    .filter((l) => l.id !== target.id)
    .map((l) => ({
      sourceText: l.sourceText,
      quantity: l.quantity,
      unitHint: l.unitHint,
      skuId: l.skuId,
      name: l.sku!.name,
      unitPricePaise: l.unitPricePaise,
      method: l.method,
      confidence: l.confidence,
      wasSubstituted: l.wasSubstituted,
      alternates: [],
      needsDisambiguation: false,
    }));

  if (options.length) {
    survivors.push({
      sourceText: target.sourceText,
      quantity: target.quantity,
      unitHint: target.unitHint,
      skuId: null,
      name: target.sourceText,
      unitPricePaise: 0,
      method: 'UNRESOLVED',
      confidence: 0,
      wasSubstituted: false,
      alternates: options.map((s) => ({ skuId: s.id, name: s.name, score: 0 })),
      needsDisambiguation: true,
    });
  }

  // the order as quoted no longer exists, so it is retired and rebuilt
  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });
  ctx.convo.pending = null;

  if (!options.length) {
    // nothing to offer: drop the line and re-quote what is left
    if (!survivors.length) {
      return speak(ctx, { kind: 'ORDER_CANCELLED' }, copy.CANCELLED);
    }
    return placeOrder(ctx, survivors, true);
  }

  ctx.meta = { ...ctx.meta, startedAt: Date.now() };
  const reply = await speak(
    ctx,
    { kind: 'REJECTED', rejected: target.sku!.name, options: options.map((s) => s.name) },
    copy.rejected(target.sku!.name),
  );

  // hold the question so the answer lands, carrying the survivors with it
  ctx.convo.pending = {
    kind: 'DISAMBIGUATE',
    lines: survivors,
    index: survivors.length - 1,
    options: options.map((s) => ({ skuId: s.id, name: s.name })),
    meta: ctx.meta,
    askedAt: new Date().toISOString(),
  };
  return reply;
}

/**
 * Cancel an order the customer is replacing, and hand back its lines.
 *
 * Cancelled rather than deleted: the row is the only record that the
 * customer once agreed to this exact basket, and the eval harness reads
 * order history. Prices are carried as they were quoted, not re-read from
 * today's catalogue, because the customer is amending the basket they were
 * shown and repricing it underneath them would be a different order.
 */
async function supersede(orderId: string): Promise<PendingLine[]> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lines: { include: { sku: true } } },
  });
  if (!order || order.status !== 'AWAITING') return [];

  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });

  return order.lines
    .filter((l) => l.sku)
    .map((l) => ({
      sourceText: l.sourceText,
      quantity: l.quantity,
      unitHint: l.unitHint,
      skuId: l.skuId,
      name: l.sku!.name,
      unitPricePaise: l.unitPricePaise,
      method: l.method,
      confidence: l.confidence,
      wasSubstituted: l.wasSubstituted,
      alternates: [],
      needsDisambiguation: false,
    }));
}

/** retire a question nobody answered, and any order hanging off it */
async function expire(pending: Pending): Promise<void> {
  if (pending.kind === 'CONFIRM') {
    await prisma.order.updateMany({
      where: { id: pending.orderId, status: 'AWAITING' },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }
}

function reAsk(ctx: Ctx, pending: Pending): Promise<OutboundMessage[]> {
  if (pending.kind === 'DISAMBIGUATE') {
    const line = pending.lines[pending.index]!;
    const names = pending.options.map((o) => o.name);
    return speak(
      ctx,
      { kind: 'ASK_WHICH', sourceText: line.sourceText, options: names },
      copy.askWhich(line.sourceText, names),
    );
  }
  return speak(ctx, { kind: 'STILL_WAITING' }, copy.STILL_WAITING);
}
