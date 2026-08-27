import { prisma } from '@nukkad/db';
import { rupeeLabel } from '@nukkad/shared';
import type { InboundMessage, OutboundMessage, ResolvedLine } from '@nukkad/shared';
import { transcribe } from '../asr/index.js';
import { isAudio, isImage } from '../asr/audio.js';
import { extractOrder } from '../extraction/extract.js';
import { getCatalog, getStockMap } from '../catalog/cache.js';
import { buildPrior } from '../resolver/prior.js';
import { rankLine, DEFAULT_RANK } from '../resolver/rank.js';
import { findSubstitutes } from '../substitution/substitute.js';
import { hasVision } from '../../config/env.js';
import { readAnswer } from './reply.js';
import { compose, type Facts } from './compose.js';
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
  return [{ text }];
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
    // No multimodal model exists on this Groq account, so photo input is
    // out of scope rather than silently broken. Say so plainly.
    return speak(ctx, { kind: 'NO_PHOTO' }, copy.NO_PHOTO);
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
    ctx.convo.pending = null;
  }

  return act(ctx, carried);
}

// ---------------------------------------------------------------- intents

/**
 * Read what they want and do it.
 *
 * This is where the four-item menu used to be. Every branch below was
 * previously a number the customer had to find and type.
 */
async function act(ctx: Ctx, carried: PendingLine[]): Promise<OutboundMessage[]> {
  const extraction = await extractOrder(ctx.said);

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
    return speak(ctx, { kind: 'NOT_UNDERSTOOD' }, copy.NOT_UNDERSTOOD);
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

  // ---- stock check and substitution BEFORE the card, never after ------
  const substituted: string[] = [];
  for (const line of resolved) {
    if (!line.chosen) continue;
    if ((stock.get(line.chosen.sku.id) ?? 0) >= line.quantity) continue;

    const subs = findSubstitutes(line.chosen.sku, catalog, stock, prior);
    if (subs.length) {
      substituted.push(line.chosen.sku.name);
      line.alternates = [line.chosen, ...line.alternates].slice(0, 2);
      line.chosen = subs[0]!;
    }
  }

  return advance(
    ctx,
    merge(carried, resolved.map(flatten)),
    carried.length > 0,
    substituted,
  );
}

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

  if (spans.length) {
    const [catalog, stock, prior] = await Promise.all([
      getCatalog(ctx.kiranaId),
      getStockMap(ctx.kiranaId),
      buildPrior(ctx.householdId),
    ]);
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
  }

  return speak(ctx, { kind: 'QUESTION' }, copy.QUESTION, card);
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
  substituted: string[] = [],
): Promise<OutboundMessage[]> {
  const index = lines.findIndex((l) => l.needsDisambiguation);

  if (index >= 0) {
    const line = lines[index]!;
    const options = [
      ...(line.skuId ? [{ skuId: line.skuId, name: line.name }] : []),
      ...line.alternates.map((a) => ({ skuId: a.skuId, name: a.name })),
    ];

    // Nothing to offer means nothing to ask. Drop the line rather than
    // send a question with an empty option list.
    if (!options.length) {
      line.needsDisambiguation = false;
      line.skuId = null;
      return advance(ctx, lines, amended, substituted);
    }

    ctx.convo.pending = {
      kind: 'DISAMBIGUATE',
      lines, index, options, meta: ctx.meta,
      askedAt: new Date().toISOString(),
    };

    const names = options.map((o) => o.name);
    return speak(
      ctx,
      { kind: 'ASK_WHICH', sourceText: line.sourceText, options: names },
      copy.askWhich(line.sourceText, names),
    );
  }

  return placeOrder(ctx, lines, amended, substituted);
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
  substituted: string[] = [],
): Promise<OutboundMessage[]> {
  const kept = lines.filter((l) => l.skuId);
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
      : { kind: 'ORDER_DRAFT', substituted },
    copy.readyToSend(),
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

  if (a.kind !== 'CHOICE' && a.kind !== 'NONE_OF_THESE') return null;

  const lines = pending.lines;
  const line = lines[pending.index]!;

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
  } else {
    line.skuId = null;
  }
  line.needsDisambiguation = false;

  // meta comes from the pending context, not from this turn: the order
  // belongs to the voice note that started it, not to the word "basmati"
  ctx.meta = pending.meta;
  return advance(ctx, lines, false);
}

// ---------------------------------------------------------------- upkeep

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
