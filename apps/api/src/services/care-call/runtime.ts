import { randomUUID } from 'node:crypto';
import { prisma } from '@nukkad/db';
import type { PendingLine } from '../conversation/state.js';
import { loadConvo, save } from '../conversation/state.js';
import { orderCard } from '../conversation/messages.js';
import { handle } from '../conversation/core.js';
import type { Desk } from '../policy/desks.js';
import { toE164 } from '../../lib/phone.js';
import { env } from '../../config/env.js';
import { readCareCallReply, type CareCallFrame, type CareCallStage } from './intent.js';
import type { buildCareCallPlans } from './plan.js';

export type CareCallChannel = 'care-call' | 'care-call-test';

export interface PendingCareCall {
  kiranaId: string;
  householdId: string;
  householdName: string;
  householdPhone: string;
  shopName: string;
  shopPhone: string;
  dueItems: string[];
  dueLines: Array<{
    skuId: string;
    name: string;
    category: string | null;
    sellPaise: number;
    quantityHint: number | null;
  }>;
  permissionScript: string;
  contextScript: string;
  openingScript: string;
}

export interface CareCallTurn {
  stage: CareCallStage;
  heard: string;
  reply: string;
  action: string;
  totalMs: number;
  agentText?: string;
}

export interface CareCallSessionHooks {
  speak(text: string, ctrl: AbortController, onDone?: () => void): void;
  agentSpeech?: (ctrl: AbortController) => {
    say(sentence: string): void;
    close(): void;
  };
  closeAfter(text: string): void;
  interruptSpeech(): void;
  onTurn?: (turn: CareCallTurn) => void;
  onDesk?: (desk: Desk) => void;
  onLog?: (event: string, data: Record<string, unknown>) => void;
  onError?: (message: string) => void;
}

const CARE_CALL_FINAL_DEBOUNCE_MS = 900;

/**
 * One durable conversation runtime for every care-call transport.
 *
 * Twilio and the browser test page should only be audio pipes. All stage
 * movement, due-basket seeding, readbacks, checkout, barge-in cancellation
 * and audit logging live here so the demo call cannot behave differently
 * from the test harness.
 */
export class CareCallSession {
  private stage: CareCallStage = 'PERMISSION';
  private lastPrompt = '';
  private busy = false;
  private inFlight: AbortController | null = null;
  private finalTimer: ReturnType<typeof setTimeout> | null = null;
  private finalBuffer: string[] = [];
  private readonly queuedUtterances: string[] = [];

  constructor(
    private readonly call: PendingCareCall,
    private readonly channel: CareCallChannel,
    private readonly hooks: CareCallSessionHooks,
    private readonly externalIdPrefix: string,
  ) {}

  open() {
    const ctrl = new AbortController();
    this.inFlight = ctrl;
    this.stage = 'PERMISSION';
    this.rememberBotPrompt(this.call.permissionScript, 'CALL_OPENED');
    this.hooks.speak(this.call.permissionScript, ctrl);
  }

  speechStarted() {
    this.inFlight?.abort();
    this.hooks.interruptSpeech();
  }

  hearFinal(text: string) {
    if (!text.trim()) return;

    if (this.stage !== 'ORDER') {
      this.startTurn(text);
      return;
    }

    this.finalBuffer.push(text);
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.finalTimer = setTimeout(() => {
      const merged = this.finalBuffer.join(' ').trim();
      this.finalBuffer = [];
      this.finalTimer = null;
      this.startTurn(merged);
    }, CARE_CALL_FINAL_DEBOUNCE_MS);
  }

  close() {
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.inFlight?.abort();
    this.hooks.interruptSpeech();
  }

  private startTurn(text: string) {
    if (!text.trim()) return;
    if (this.busy) {
      this.queuedUtterances.push(text);
      return;
    }

    this.busy = true;
    const ctrl = new AbortController();
    this.inFlight = ctrl;

    void this.runTurn(text, ctrl)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'care-call turn failed';
        this.hooks.onError?.(message);
      })
      .finally(() => {
        this.busy = false;
        if (this.inFlight === ctrl) this.inFlight = null;
        const next = this.queuedUtterances.shift()?.trim();
        if (next) this.startTurn(next);
      });
  }

  private async runTurn(text: string, ctrl: AbortController) {
    const started = Date.now();
    const frame = await readCareCallReply({
      stage: this.stage,
      text,
      customerName: this.call.householdName,
      shopName: this.call.shopName,
      dueItems: this.call.dueItems,
      lastPrompt: this.lastPrompt,
    });

    this.hooks.onLog?.('care-call intent', { heard: text, frame, stage: this.stage, channel: this.channel });
    if (ctrl.signal.aborted) return;

    const emitTurn = (reply: string, opts: { persist?: boolean; agentText?: string } = {}) => {
      const turn = {
        stage: this.stage,
        heard: text,
        reply,
        action: frame.act,
        totalMs: Date.now() - started,
        agentText: opts.agentText,
      };
      if (opts.persist !== false) {
        this.saveEvent({
          heard: text,
          reply,
          act: frame.act,
          goal: this.stage,
          latencyMs: turn.totalMs,
        });
      }
      this.hooks.onTurn?.(turn);
    };

    if (this.stage === 'PERMISSION') {
      if (frame.act === 'PERMISSION_DENIED') {
        const reply = 'Theek hai ji, main baad mein pooch lungi. Dhanyavaad.';
        emitTurn(reply);
        this.hooks.closeAfter(reply);
        return;
      }

      if (frame.act === 'PERMISSION_GRANTED') {
        await seedCareCallBasket(this.call, this.channel);
        emitTurn(this.call.contextScript);
        this.stage = 'ORDER';
        this.hooks.speak(this.call.contextScript, ctrl);
        return;
      }

      if (frame.act === 'ADD_OR_CHANGE_ITEMS') {
        await seedCareCallBasket(this.call, this.channel);
        this.stage = 'ORDER';
      } else {
        const reply = 'Maaf kijiye, kya main order ke baare mein do minute baat kar sakti hoon?';
        emitTurn(reply);
        this.hooks.speak(reply, ctrl);
        return;
      }
    }

    if (this.stage === 'ORDER' && frame.act === 'ORDER_DECLINED') {
      const reply = 'Theek hai ji. Koi baat nahi. Dhanyavaad.';
      emitTurn(reply);
      this.hooks.closeAfter(reply);
      return;
    }

    if (this.stage === 'ORDER' && (frame.act === 'ASK_QUESTION' || wantsBasketReadback(text)) && wantsBasketReadback(text)) {
      const basket = await currentCareCallBasket(this.call, this.channel);
      const reply = basket.length
        ? `Abhi order mein ye hai:\n\n${orderCard(basket)}\n\nBhej dun?`
        : 'Abhi order khali hai. Bataiye kya chahiye?';
      emitTurn(reply);
      this.hooks.speak(reply, ctrl);
      return;
    }

    const agentText = careCallTextForAgent(frame, this.call.dueItems, text);
    let streamed = false;
    const agentSpeech = this.hooks.agentSpeech?.(ctrl);
    const replies = await handle(
      {
        channel: this.channel,
        senderId: toE164(this.call.householdPhone),
        recipientId: toE164(this.call.shopPhone),
        text: agentText,
        media: [],
        externalId: `${this.externalIdPrefix}_${randomUUID()}`,
        receivedAt: new Date(),
      },
      {
        onDesk: this.hooks.onDesk,
        onSentence: (sentence) => {
          streamed = true;
          agentSpeech?.say(`${sentence} `);
        },
      },
    ).finally(() => {
      if (agentSpeech) setTimeout(() => agentSpeech.close(), 4000);
    });

    if (ctrl.signal.aborted) return;

    const said = replies.map((r) => r.text).filter(Boolean).join(' ') || 'Theek hai ji.';
    this.lastPrompt = said;
    this.hooks.onLog?.('care-call turn', { heard: text, agentText, said, channel: this.channel });
    emitTurn(said, { persist: false, agentText });
    if (!streamed) this.hooks.speak(said.split('\n\n')[0] || said, ctrl);
  }

  private rememberBotPrompt(text: string, act = 'BOT_PROMPT') {
    this.saveEvent({ heard: '', reply: text, act, goal: this.stage });
  }

  private saveEvent(event: {
    heard: string;
    reply: string | null;
    act?: string | null;
    goal?: string | null;
    latencyMs?: number;
  }) {
    void prisma.agentEvent
      .create({
        data: {
          kiranaId: this.call.kiranaId,
          householdId: this.call.householdId,
          channel: this.channel,
          desk: 'CARE_CALL',
          act: event.act ?? null,
          goal: event.goal ?? this.stage,
          heard: event.heard.slice(0, 500),
          reply: event.reply?.split('\n')[0]?.slice(0, 300) ?? null,
          latencyMs: event.latencyMs ?? 0,
        },
      })
      .catch((err) => this.hooks.onLog?.('care-call event write failed', { err }));
  }
}

export async function pendingFromPlan(
  kiranaId: string,
  plan: Awaited<ReturnType<typeof buildCareCallPlans>>[number],
): Promise<PendingCareCall> {
  return {
    householdId: plan.household.id,
    kiranaId,
    householdName: plan.household.name,
    householdPhone: plan.household.phone,
    shopName: plan.shop.name,
    shopPhone: env.TWILIO_WHATSAPP_FROM.replace('whatsapp:', ''),
    dueItems: plan.lines.map((line) => line.name),
    dueLines: plan.lines.map((line) => ({
      skuId: line.skuId,
      name: line.name,
      category: line.category,
      sellPaise: line.sellPaise,
      quantityHint: line.quantityHint,
    })),
    permissionScript: `Namaste ${plan.household.name} ji, main ${plan.shop.name} se bol rahi hoon. Kya main aapse order ke baare mein do minute baat kar sakti hoon?`,
    contextScript: plan.openingScript
      .replace(/^Namaste .*? se bol rahi hoon\. /, '')
      .replace(/^Agar aap free ho to kya main aapse 2 minute baat kar sakti hoon\? /, ''),
    openingScript: plan.openingScript,
  };
}

async function seedCareCallBasket(call: PendingCareCall, channel: CareCallChannel) {
  const peerPhone = toE164(call.householdPhone);
  const lines: PendingLine[] = call.dueLines.map((line) => ({
    sourceText: line.name,
    quantity: Math.max(1, line.quantityHint ?? 1),
    unitHint: null,
    skuId: line.skuId,
    category: line.category,
    name: line.name,
    unitPricePaise: line.sellPaise,
    method: 'EXACT',
    confidence: 1,
    wasSubstituted: false,
    alternates: [],
    needsDisambiguation: false,
  }));
  const convo = await loadConvo(channel, peerPhone, call.householdId, call.kiranaId);
  convo.desk = 'SELLER';
  convo.pending = null;
  convo.basket = lines;
  convo.lastNamed = lines.slice(0, 4).map((line) => ({ skuId: line.skuId!, name: line.name }));
  await save(convo, { householdId: call.householdId, kiranaId: call.kiranaId });
}

async function currentCareCallBasket(call: PendingCareCall, channel: CareCallChannel) {
  const convo = await loadConvo(channel, toE164(call.householdPhone), call.householdId, call.kiranaId);
  return convo.basket;
}

function normalizedWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/aashirvaad|aashirwaad|ashirvaad|ashirwaad/g, 'aashirwad')
    .replace(/\baata\b/g, 'atta')
    .replace(/\baate\b/g, 'atta')
    .replace(/\b(chini|chinni|teeni)\b/g, 'sugar')
    .replace(/\b(chawal|chaawal)\b/g, 'rice')
    .replace(/\b(tel|tail)\b/g, 'oil')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4);
}

function negatedDueItems(dueItems: string[], heard: string): string[] {
  const negativeClauses = heard
    .split(/\b(?:aur|and|lekin|but|par|plus)\b|[,.]/i)
    .filter((part) => /\b(mat|nahi|nahin|hata|remove|without|except)\b/i.test(part))
    .map((part) => new Set(normalizedWords(part)));
  if (!negativeClauses.length) return [];
  return dueItems.filter((item) => {
    const words = normalizedWords(item);
    return negativeClauses.some((heardWords) => {
      const hits = words.filter((word) => heardWords.has(word)).length;
      return hits >= Math.min(2, words.length)
        || words.some((word) => heardWords.has(word) && ['atta', 'sugar', 'rice', 'oil'].includes(word));
    });
  });
}

function itemWithoutPack(item: string): string {
  return item
    .replace(/\b\d+(?:\.\d+)?\s*(?:kg|kgs|g|gm|gram|grams|l|lt|ltr|litre|liter|ml|pc|pcs|pack|packet|packets)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wantsCheckout(text: string): boolean {
  return /\b(bhej|bhejo|bhej do|bhej lo|order|kar do|pack|bill|payment|checkout|itna hi|bas itna)\b/i.test(text);
}

function wantsBasketReadback(text: string): boolean {
  return /\b(kya kya|kya-kya|abhi order|order mein|basket|bag|bill kitna|total|kitna hua)\b/i.test(text);
}

function careCallTextForAgent(frame: CareCallFrame, dueItems: string[], heard: string): string {
  const excluded = negatedDueItems(dueItems, heard);
  if (frame.act === 'ADD_OR_CHANGE_ITEMS' && excluded.length) {
    return `${excluded.map(itemWithoutPack).join(', ')} nahi chahiye`;
  }
  if (frame.act === 'ORDER_ACCEPTED' || frame.act === 'CHECKOUT' || wantsCheckout(heard)) return 'bhej do';
  return heard;
}
