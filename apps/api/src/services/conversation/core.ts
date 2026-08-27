import { prisma } from '@nukkad/db';
import type { InboundMessage, OutboundMessage, ResolvedLine, Sku } from '@nukkad/shared';
import { transcribe } from '../asr/index.js';
import { isAudio, isImage } from '../asr/audio.js';
import { extractOrder } from '../extraction/extract.js';
import { getCatalog, getStockMap } from '../catalog/cache.js';
import { buildPrior } from '../resolver/prior.js';
import { rankLine, DEFAULT_RANK } from '../resolver/rank.js';
import { findSubstitutes } from '../substitution/substitute.js';
import { hasVision } from '../../config/env.js';
import { readAnswer } from './reply.js';
import {
  loadConvo, setPending, clearPending, flatten, isStale,
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
 * IT IS ALSO A STATE MACHINE, which it was not until recently. See
 * ./state.ts for why that was the single biggest hole in the WhatsApp
 * agent: every card offered numbered taps and no tap did anything.
 *
 * The shape of a turn is:
 *
 *   route to shop and household
 *   turn whatever arrived into text
 *   IF a question is outstanding, try to read this as the ANSWER
 *   otherwise, or if that fails, treat it as a NEW ORDER
 *
 * The "or if that fails" is load-bearing. A customer staring at a confirm
 * card who types "aur ek kilo chini bhi" has not answered anything, and a
 * machine that insists on a digit would throw that away.
 */

/** Twilio's shared sandbox sender. Identifies no particular shop. */
const SANDBOX_NUMBER = '+14155238886';

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
    return [{ text: 'Aapka number register nahi hai. Apne dukaandaar se poochhein.' }];
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

  const image = msg.media.find((m) => isImage(m.mime));
  if (image && !hasVision) {
    // No multimodal model exists on this Groq account, so photo input is
    // out of scope rather than silently broken. Say so plainly.
    return [{ text: 'Abhi photo nahi padh sakte. Bol kar ya likh kar bhej dijiye.' }];
  }

  const meta: OrderMeta = {
    source: audio ? 'VOICE' : 'TEXT',
    rawText: msg.text ?? null,
    transcript,
    asrEngine,
    mediaPath: audio?.localPath ?? null,
    startedAt: started,
  };

  // ---- 2. is an answer outstanding? -----------------------------------
  let pending = convo.pending;

  if (pending && isStale(pending)) {
    // Six hours on, this is not an answer to anything. Retire it rather
    // than leave the order sitting in the shop's pending count forever.
    await expire(convo, pending);
    pending = null;
  }

  if (!text.trim()) {
    // An empty message cannot answer a question either, so re-ask rather
    // than dropping whatever was outstanding.
    if (pending) return [reAsk(pending)];
    await setPending(convo.id, { kind: 'MENU', askedAt: new Date().toISOString() });
    return [{ text: copy.menu(household.name), quickReplies: copy.MENU_OPTIONS }];
  }

  /**
   * Lines carried over from an order the customer is amending rather than
   * replacing. Empty in every other case.
   */
  let carried: PendingLine[] = [];

  if (pending) {
    const answered = await answer(convo, pending, text, kirana.id, household.id);
    // null means "this was not an answer" -- fall through and read it as
    // a new order, which is nearly always what the customer meant
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
    await clearPending(convo.id);
  }

  // ---- 3. segment. The model does NOT pick products. ------------------
  return newOrder(convo, text, meta, kirana.id, household.id, household.name, carried);
}

// ---------------------------------------------------------------- ordering

async function newOrder(
  convo: Convo,
  text: string,
  meta: OrderMeta,
  kiranaId: string,
  householdId: string,
  householdName: string,
  carried: PendingLine[] = [],
): Promise<OutboundMessage[]> {
  const extraction = await extractOrder(text);

  if (extraction.intent === 'CANCEL') {
    return [{ text: 'Theek hai, cancel kar diya.' }];
  }
  if (!extraction.items.length) {
    // Anything carried from a superseded order is put back rather than
    // dropped: failing to parse the amendment is no reason to lose what
    // the customer had already agreed to.
    if (carried.length) {
      return placeOrder(convo, carried, meta, kiranaId, householdId, true);
    }
    await setPending(convo.id, { kind: 'MENU', askedAt: new Date().toISOString() });
    return [{ text: copy.menu(householdName), quickReplies: copy.MENU_OPTIONS }];
  }

  // ---- rank against THIS shop's catalogue, with THIS household's prior
  const [catalog, stock, prior] = await Promise.all([
    getCatalog(kiranaId),
    getStockMap(kiranaId),
    buildPrior(householdId),
  ]);

  const resolved: ResolvedLine[] = extraction.items.map((it) =>
    rankLine(it.text, it.quantity, it.unit, catalog, prior, DEFAULT_RANK),
  );

  // ---- stock check and substitution BEFORE the card, never after ------
  for (const line of resolved) {
    if (!line.chosen) continue;
    if ((stock.get(line.chosen.sku.id) ?? 0) >= line.quantity) continue;

    const subs = findSubstitutes(line.chosen.sku, catalog, stock, prior);
    if (subs.length) {
      line.alternates = [line.chosen, ...line.alternates].slice(0, 2);
      line.chosen = subs[0]!;
    }
  }

  return advance(convo, merge(carried, resolved.map(flatten)), meta, kiranaId, householdId, catalog, carried.length > 0);
}

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
  convo: Convo,
  lines: PendingLine[],
  meta: OrderMeta,
  kiranaId: string,
  householdId: string,
  catalog: Sku[],
  amended = false,
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
      return advance(convo, lines, meta, kiranaId, householdId, catalog, amended);
    }

    await setPending(convo.id, {
      kind: 'DISAMBIGUATE',
      lines, index, options, meta,
      askedAt: new Date().toISOString(),
    });
    return [{
      text: copy.disambiguation(line.sourceText, options.map((o) => o.name)),
      quickReplies: options.map((o, i) => ({ id: String(i + 1), label: o.name })),
    }];
  }

  return placeOrder(convo, lines, meta, kiranaId, householdId, amended);
}

/**
 * Writes the Order at AWAITING and asks for the tap that confirms it.
 *
 * The row is written HERE and not before, because until the questions are
 * answered there is no order -- only a conversation. Half-finished ones
 * used to be persisted anyway and then counted in the shop's pending total.
 */
async function placeOrder(
  convo: Convo,
  lines: PendingLine[],
  meta: OrderMeta,
  kiranaId: string,
  householdId: string,
  amended = false,
): Promise<OutboundMessage[]> {
  const kept = lines.filter((l) => l.skuId);
  if (!kept.length) {
    await clearPending(convo.id);
    return [{ text: copy.nothingUnderstood() }];
  }

  const total = kept.reduce((sum, l) => sum + l.unitPricePaise * l.quantity, 0);

  const order = await prisma.order.create({
    data: {
      kiranaId, householdId,
      status: 'AWAITING',
      source: meta.source,
      rawText: meta.rawText,
      transcript: meta.transcript,
      asrEngine: meta.asrEngine,
      mediaPath: meta.mediaPath,
      latencyMs: Date.now() - meta.startedAt,
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

  await setPending(convo.id, {
    kind: 'CONFIRM', orderId: order.id, askedAt: new Date().toISOString(),
  });

  return [{
    text: copy.confirmCard(kept, Math.round(total), amended) + `\n\n(#${order.id.slice(-6)})`,
    quickReplies: copy.CONFIRM_OPTIONS,
  }];
}

// ---------------------------------------------------------------- answering

/**
 * Reads `text` as the answer to whatever is outstanding.
 *
 * Returns null when it is not an answer at all, which is the signal to the
 * caller to treat the message as a new order instead. That is the whole
 * escape hatch, and it is why the vocabulary in ./reply.ts can stay short.
 */
async function answer(
  convo: Convo,
  pending: Pending,
  text: string,
  kiranaId: string,
  householdId: string,
): Promise<OutboundMessage[] | null> {
  if (pending.kind === 'MENU') {
    const a = readAnswer(text, copy.MENU_OPTIONS.length);
    if (a.kind !== 'CHOICE') return null;
    return menuChoice(convo, a.index, kiranaId, householdId);
  }

  if (pending.kind === 'CONFIRM') {
    // three numbered options on the card: send / change / cancel
    const a = readAnswer(text, copy.CONFIRM_OPTIONS.length);

    const yes = a.kind === 'YES' || (a.kind === 'CHOICE' && a.index === 0);
    const change = a.kind === 'CHANGE' || (a.kind === 'CHOICE' && a.index === 1);
    const no = a.kind === 'NO' || (a.kind === 'CHOICE' && a.index === 2);

    if (yes) {
      const order = await prisma.order.update({
        where: { id: pending.orderId },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      });
      await clearPending(convo.id);
      return [{ text: copy.confirmed(order.totalPaise, order.id.slice(-6)) }];
    }

    if (no) {
      await prisma.order.update({
        where: { id: pending.orderId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await clearPending(convo.id);
      return [{ text: copy.cancelled() }];
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
      await clearPending(convo.id);
      return [{ text: copy.sendAgain() }];
    }

    return null;
  }

  // ---- disambiguation --------------------------------------------------
  // options plus one more for "none of these"
  const a = readAnswer(text, pending.options.length + 1);
  if (a.kind !== 'CHOICE') return null;

  const lines = pending.lines;
  const line = lines[pending.index]!;
  const picked = pending.options[a.index];
  const catalog = await getCatalog(kiranaId);

  if (picked) {
    const sku = catalog.find((s) => s.id === picked.skuId);
    line.skuId = picked.skuId;
    line.name = picked.name;
    line.unitPricePaise = sku?.sellPaise ?? line.unitPricePaise;
    // the buyer chose it, so the confidence is theirs and not the ranker's
    line.method = 'DISAMBIGUATED';
    line.confidence = 1;
  } else {
    // the trailing "koi nahi" option: drop the line entirely
    line.skuId = null;
  }
  line.needsDisambiguation = false;

  return advance(convo, lines, pending.meta, kiranaId, householdId, catalog);
}

async function menuChoice(
  convo: Convo,
  index: number,
  kiranaId: string,
  householdId: string,
): Promise<OutboundMessage[]> {
  // 1 = repeat last order, 2 = new order, 3 = my account, 4 = automatic
  if (index === 0) {
    const last = await prisma.order.findFirst({
      where: { householdId, status: { in: ['CONFIRMED', 'FULFILLED'] } },
      orderBy: { createdAt: 'desc' },
      include: { lines: { include: { sku: true } } },
    });
    if (!last?.lines.length) {
      await clearPending(convo.id);
      return [{ text: copy.noPreviousOrder() }];
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

    return placeOrder(convo, lines, {
      source: 'TEXT', rawText: null, transcript: null, asrEngine: null,
      mediaPath: null, startedAt: Date.now(),
    }, kiranaId, householdId);
  }

  if (index === 2) {
    const [orders, spend] = await Promise.all([
      prisma.order.count({ where: { householdId, status: { in: ['CONFIRMED', 'FULFILLED'] } } }),
      prisma.order.aggregate({
        where: { householdId, status: { in: ['CONFIRMED', 'FULFILLED'] } },
        _sum: { totalPaise: true },
      }),
    ]);
    await clearPending(convo.id);
    return [{ text: copy.account(orders, spend._sum.totalPaise ?? 0) }];
  }

  // 2 = new order and 4 = automatic both just wait for the next message.
  // Automatic ordering is a tier change the shopkeeper sets, not something
  // to switch on from a tap, so it says so rather than pretending.
  await clearPending(convo.id);
  return [{ text: index === 3 ? copy.autoOrderNotYet() : copy.askForOrder() }];
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
async function expire(convo: Convo, pending: Pending): Promise<void> {
  if (pending.kind === 'CONFIRM') {
    await prisma.order.updateMany({
      where: { id: pending.orderId, status: 'AWAITING' },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }
  await clearPending(convo.id);
}

function reAsk(pending: Pending): OutboundMessage {
  if (pending.kind === 'DISAMBIGUATE') {
    const line = pending.lines[pending.index]!;
    return {
      text: copy.disambiguation(line.sourceText, pending.options.map((o) => o.name)),
      quickReplies: pending.options.map((o, i) => ({ id: String(i + 1), label: o.name })),
    };
  }
  if (pending.kind === 'CONFIRM') {
    return { text: copy.stillWaiting(), quickReplies: copy.CONFIRM_OPTIONS };
  }
  return { text: copy.menuAgain(), quickReplies: copy.MENU_OPTIONS };
}
