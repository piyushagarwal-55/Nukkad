import { prisma } from '@nukkad/db';
import type { InboundMessage, OutboundMessage, ResolvedLine } from '@nukkad/shared';
import { transcribeGroq } from '../asr/index.js';
import { isAudio, isImage } from '../asr/audio.js';
import { extractOrder } from '../extraction/extract.js';
import { getCatalog, getStockMap } from '../catalog/cache.js';
import { buildPrior } from '../resolver/prior.js';
import { rankLine, DEFAULT_RANK } from '../resolver/rank.js';
import { findSubstitutes } from '../substitution/substitute.js';
import { hasVision } from '../../config/env.js';
import * as copy from './messages.js';

/**
 * The channel-agnostic brain.
 *
 * Nothing in this file imports Twilio, or fetch, or a transport SDK. It
 * takes an InboundMessage and returns OutboundMessages. That is exactly
 * what lets the web simulator run the identical pipeline as a real phone.
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

  // ---- 1. get text, from whichever modality arrived -------------------
  let text = msg.text ?? '';
  let transcript: string | null = null;
  let asrEngine: string | null = null;

  const audio = msg.media.find((m) => isAudio(m.mime));
  if (audio) {
    const t = await transcribeGroq(audio.localPath);
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

  if (!text.trim()) {
    return [{ text: copy.menu(household.name), quickReplies: copy.MENU_OPTIONS }];
  }

  // ---- 2. segment. The model does NOT pick products. ------------------
  const extraction = await extractOrder(text);

  if (extraction.intent === 'CANCEL') {
    return [{ text: 'Theek hai, cancel kar diya.' }];
  }
  if (!extraction.items.length) {
    return [{ text: copy.menu(household.name), quickReplies: copy.MENU_OPTIONS }];
  }

  // ---- 3. rank against THIS shop's catalogue, with THIS household's prior
  const [catalog, stock, prior] = await Promise.all([
    getCatalog(kirana.id),
    getStockMap(kirana.id),
    buildPrior(household.id),
  ]);

  const lines: ResolvedLine[] = extraction.items.map((it) =>
    rankLine(it.text, it.quantity, it.unit, catalog, prior, DEFAULT_RANK),
  );

  // ---- 4. stock check and substitution BEFORE the card, never after ---
  for (const line of lines) {
    if (!line.chosen) continue;
    if ((stock.get(line.chosen.sku.id) ?? 0) >= line.quantity) continue;

    const subs = findSubstitutes(line.chosen.sku, catalog, stock, prior);
    if (subs.length) {
      line.alternates = [line.chosen, ...line.alternates].slice(0, 2);
      line.chosen = subs[0]!;
    }
  }

  // ---- 5. anything uncertain goes to the buyer as taps ----------------
  const unsure = lines.find((l) => l.needsDisambiguation);
  if (unsure) {
    return [{ text: copy.disambiguation(unsure) }];
  }

  const total = lines.reduce(
    (sum, l) => sum + (l.chosen ? l.chosen.sku.sellPaise * l.quantity : 0), 0,
  );

  // ---- 6. persist, so the ablation is derivable from production -------
  const order = await prisma.order.create({
    data: {
      kiranaId: kirana.id,
      householdId: household.id,
      status: 'AWAITING',
      source: audio ? 'VOICE' : 'TEXT',
      rawText: msg.text ?? null,
      transcript,
      asrEngine,
      mediaPath: audio?.localPath ?? null,
      latencyMs: Date.now() - started,
      totalPaise: Math.round(total),
      lines: {
        create: lines.map((l) => ({
          skuId: l.chosen?.sku.id ?? null,
          sourceText: l.sourceText,
          quantity: l.quantity,
          unitHint: l.unitHint,
          unitPricePaise: l.chosen?.sku.sellPaise ?? 0,
          linePaise: Math.round((l.chosen?.sku.sellPaise ?? 0) * l.quantity),
          method: (l.chosen?.method ?? 'UNRESOLVED') as never,
          confidence: l.confidence,
          wasSubstituted: l.chosen?.method === 'SUBSTITUTED',
          alternatesJson: l.alternates.map((a) => ({
            skuId: a.sku.id, name: a.sku.name, score: a.score,
          })) as never,
        })),
      },
    },
  });

  return [{
    text: copy.confirmCard(lines, Math.round(total)) + `\n\n(#${order.id.slice(-6)})`,
    quickReplies: copy.CONFIRM_OPTIONS,
  }];
}
