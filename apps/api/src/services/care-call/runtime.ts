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
  outcome: CareCallOutcome;
  memory: ConversationFrame;
}

export interface CareCallOutcome {
  name:
    | 'PERMISSION_ALLOWED'
    | 'PERMISSION_REFUSED'
    | 'PERMISSION_REASK'
    | 'DUE_BASKET_SEEDED'
    | 'BASKET_REVIEWED'
    | 'ORDER_DECLINED'
    | 'ORDER_ENGINE_HANDOFF'
    | 'WHATSAPP_RECEIPT_SENT'
    | 'POST_CHECKOUT_CONTINUE'
    | 'POST_CHECKOUT_CLOSED'
    | 'POST_CHECKOUT_REASK'
    | 'END_CALL'
    | 'NO_MORE_ITEMS_CHECKOUT'
    | 'CHECKOUT_REJECTED'
    | 'CANCEL_ORDER'
    | 'WHATSAPP_RECEIPT_FAILED';
  preconditions: string[];
  tools: string[];
  nextStage: CareCallStage | 'ENDED';
  verified: boolean;
}

export interface CareCallSessionHooks {
  speak(text: string, ctrl: AbortController, onDone?: () => void): void;
  agentSpeech?: (ctrl: AbortController) => {
    say(sentence: string): void;
    close(): void;
  };
  closeAfter(text: string): void;
  interruptSpeech(): void;
  sendReceipt?: (text: string) => Promise<{ sid?: string; status?: string } | void>;
  onTurn?: (turn: CareCallTurn) => void;
  onDesk?: (desk: Desk) => void;
  onLog?: (event: string, data: Record<string, unknown>) => void;
  onError?: (message: string) => void;
}

const CARE_CALL_FINAL_DEBOUNCE_MS = 900;

type CareDesk = 'RECEPTION' | 'SELLER' | 'CHECKOUT' | 'ENQUIRY';
type CareState = 'OPENING' | 'BUYING' | 'REVIEWING_BASKET' | 'CHECKOUT' | 'POST_CHECKOUT' | 'ENDED';

interface MemoryPending {
  type: 'CONFIRM_DUE_BASKET' | 'CONFIRM_CHECKOUT' | 'ASK_MORE_ITEMS' | 'POST_CHECKOUT_MORE';
  product: string | null;
  quantity: number | null;
  expiresAfterTurns: number;
}

export interface ConversationFrame {
  desk: CareDesk;
  previousDesk: CareDesk | null;
  state: CareState;
  turn: number;
  pending: MemoryPending | null;
  referents: {
    lastProduct: string | null;
    lastOptions: string[];
    lastOrderRef: string | null;
  };
  lastBotQuestion: string | null;
}

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
  private eventSeq = 0;
  private memory: ConversationFrame = {
    desk: 'RECEPTION',
    previousDesk: null,
    state: 'OPENING',
    turn: 0,
    pending: null,
    referents: { lastProduct: null, lastOptions: [], lastOrderRef: null },
    lastBotQuestion: null,
  };

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
    this.setDesk('RECEPTION');
    this.memory.state = 'OPENING';
    this.memory.lastBotQuestion = this.call.permissionScript;
    this.recordEvent('CALL_STARTED', {
      goal: this.fsm('IDLE'),
      reply: this.call.permissionScript,
      latencyMs: 0,
    });
    this.recordEvent('RESPONSE_GENERATED', {
      goal: this.fsm('RECEPTION'),
      reply: this.call.permissionScript,
      latencyMs: 0,
    });
    this.hooks.speak(this.call.permissionScript, ctrl);
  }

  speechStarted() {
    this.inFlight?.abort();
    this.recordEvent('SPEECH_INTERRUPTED', {
      goal: this.fsm('UNDERSTANDING'),
      latencyMs: 0,
    });
    this.hooks.interruptSpeech();
  }

  hearFinal(text: string) {
    if (!text.trim()) return;
    this.recordEvent('SPEECH_FINAL', {
      goal: this.fsm('UNDERSTANDING'),
      heard: text,
      latencyMs: 0,
    });

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
    this.recordEvent('CALL_ENDED', {
      goal: this.fsm('ENDED'),
      latencyMs: 0,
    });
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
    this.beginUserTurn();
    const terminal = readTerminalAct(text);
    const frame = terminal ?? await readCareCallReply({
      stage: this.stage,
      text,
      customerName: this.call.householdName,
      shopName: this.call.shopName,
      dueItems: this.call.dueItems,
      lastPrompt: this.lastPrompt,
    });

    this.hooks.onLog?.('care-call intent', { heard: text, frame, stage: this.stage, channel: this.channel });
    this.recordEvent('INTENT_DETECTED', {
      goal: this.fsm('UNDERSTANDING'),
      heard: text,
      reply: `confidence=${frame.confidence.toFixed(2)}`,
      latencyMs: Date.now() - started,
    });
    if (ctrl.signal.aborted) return;
    const negative = readSemanticNegative(text, this.memory);
    if (negative) {
      this.recordEvent('DECISION_MADE', {
        goal: this.fsm('SEMANTIC_RESOLVER'),
        heard: text,
        reply: negative.action,
        latencyMs: Date.now() - started,
      });
    }

    const emitTurn = (
      reply: string,
      outcome: CareCallOutcome,
      opts: { persist?: boolean; agentText?: string } = {},
    ) => {
      this.memory.lastBotQuestion = reply.includes('?') ? reply : this.memory.lastBotQuestion;
      const turn = {
        stage: this.stage,
        heard: text,
        reply,
        action: frame.act,
        totalMs: Date.now() - started,
        agentText: opts.agentText,
        outcome,
        memory: this.memorySnapshot(),
      };
      this.recordOutcome(outcome, text, reply, turn.totalMs);
      if (opts.persist !== false) {
        this.recordEvent('TURN_COMPLETED', {
          heard: text,
          reply,
          act: frame.act,
          goal: this.stage,
          latencyMs: turn.totalMs,
        });
      }
      this.hooks.onTurn?.(turn);
    };

    if (frame.act === 'PERMISSION_DENIED' && terminal) {
      const reply = `Dhanyavaad ji. ${this.call.shopName} se shopping karne ke liye shukriya.`;
      emitTurn(reply, outcome('END_CALL', ['explicit_terminal_command'], [], 'ENDED'));
      this.hooks.closeAfter(reply);
      return;
    }

    if (negative?.action === 'CANCEL_ORDER') {
      const reply = 'Theek hai ji, order cancel kar diya. Dhanyavaad.';
      this.memory.state = 'ENDED';
      this.memory.pending = null;
      emitTurn(reply, outcome('CANCEL_ORDER', ['explicit_cancel_order'], [], 'ENDED'));
      this.hooks.closeAfter(reply);
      return;
    }

    if (this.stage === 'POST_CHECKOUT') {
      if (frame.act === 'PERMISSION_DENIED' || frame.act === 'ORDER_DECLINED' || isDoneAfterCheckout(text)) {
        const reply = `Dhanyavaad ji. ${this.call.shopName} se shopping karne ke liye shukriya.`;
        this.memory.state = 'ENDED';
        this.memory.pending = null;
        emitTurn(reply, outcome('POST_CHECKOUT_CLOSED', ['checkout_receipt_sent', 'customer_done'], [], 'ENDED'));
        this.hooks.closeAfter(reply);
        return;
      }

      if (frame.act === 'PERMISSION_GRANTED' || frame.act === 'ORDER_ACCEPTED') {
        const reply = 'Haan ji, bataiye aur kya chahiye?';
        this.setDesk('SELLER');
        this.memory.state = 'BUYING';
        this.setPending('ASK_MORE_ITEMS');
        emitTurn(reply, outcome('POST_CHECKOUT_CONTINUE', ['checkout_receipt_sent', 'customer_wants_more'], [], 'ORDER'));
        this.stage = 'ORDER';
        this.hooks.speak(reply, ctrl);
        return;
      }

      if (frame.act !== 'ADD_OR_CHANGE_ITEMS') {
        const reply = 'Aur kuch chahiye to bata dijiye, warna main call yahin close kar deti hoon.';
        this.setPending('POST_CHECKOUT_MORE');
        emitTurn(reply, outcome('POST_CHECKOUT_REASK', ['checkout_receipt_sent', 'unclear_reply'], [], 'POST_CHECKOUT'));
        this.hooks.speak(reply, ctrl);
        return;
      }

      this.stage = 'ORDER';
    }

    if (this.stage === 'ORDER' && negative?.action === 'CHECKOUT_REJECTED') {
      const reply = 'Theek hai ji, bill abhi nahi bhejti. Aur kuch badalna ho to bata dijiye.';
      this.setDesk('SELLER');
      this.memory.state = 'BUYING';
      this.setPending('ASK_MORE_ITEMS');
      emitTurn(reply, outcome('CHECKOUT_REJECTED', ['checkout_confirmation_rejected'], [], 'ORDER'));
      this.hooks.speak(reply, ctrl);
      return;
    }

    if (this.stage === 'ORDER' && negative?.action === 'REJECT_PRODUCT') {
      frame.act = 'ADD_OR_CHANGE_ITEMS';
    }

    if (this.stage === 'PERMISSION') {
      if (frame.act === 'PERMISSION_DENIED') {
        const reply = 'Theek hai ji, main baad mein pooch lungi. Dhanyavaad.';
        this.memory.state = 'ENDED';
        this.memory.pending = null;
        emitTurn(reply, outcome('PERMISSION_REFUSED', ['permission_reply'], [], 'ENDED'));
        this.hooks.closeAfter(reply);
        return;
      }

      if (frame.act === 'PERMISSION_GRANTED') {
        await seedCareCallBasket(this.call, this.channel);
        this.setDesk('SELLER');
        this.memory.state = 'BUYING';
        this.setPending('CONFIRM_DUE_BASKET');
        emitTurn(
          this.call.contextScript,
          outcome('DUE_BASKET_SEEDED', ['permission_granted', 'due_items_available'], ['load_conversation', 'seed_basket'], 'ORDER'),
        );
        this.recordEvent('STATE_CHANGED', {
          goal: this.fsm('SELLER'),
          heard: text,
          reply: 'PERMISSION -> ORDER',
          latencyMs: Date.now() - started,
        });
        this.stage = 'ORDER';
        this.hooks.speak(this.call.contextScript, ctrl);
        return;
      }

      if (frame.act === 'ADD_OR_CHANGE_ITEMS') {
        await seedCareCallBasket(this.call, this.channel);
        this.setDesk('SELLER');
        this.memory.state = 'BUYING';
        this.recordEvent('STATE_CHANGED', {
          goal: this.fsm('SELLER'),
          heard: text,
          reply: 'PERMISSION -> ORDER',
          latencyMs: Date.now() - started,
        });
        this.stage = 'ORDER';
      } else {
        const reply = 'Maaf kijiye, kya main order ke baare mein do minute baat kar sakti hoon?';
        emitTurn(reply, outcome('PERMISSION_REASK', ['unclear_permission'], [], 'PERMISSION'));
        this.hooks.speak(reply, ctrl);
        return;
      }
    }

    if (this.stage === 'ORDER' && frame.act === 'ORDER_DECLINED') {
      const reply = 'Theek hai ji. Koi baat nahi. Dhanyavaad.';
      this.memory.state = 'ENDED';
      this.memory.pending = null;
      emitTurn(reply, outcome('ORDER_DECLINED', ['customer_declined_order'], [], 'ENDED'));
      this.hooks.closeAfter(reply);
      return;
    }

    if (this.stage === 'ORDER' && (frame.act === 'ASK_QUESTION' || wantsBasketReadback(text)) && wantsBasketReadback(text)) {
      const basket = await currentCareCallBasket(this.call, this.channel);
      const reply = basket.length
        ? `Abhi order mein ye hai:\n\n${orderCard(basket)}\n\nBhej dun?`
        : 'Abhi order khali hai. Bataiye kya chahiye?';
      this.setDesk('CHECKOUT');
      this.memory.state = basket.length ? 'REVIEWING_BASKET' : 'BUYING';
      this.setPending(basket.length ? 'CONFIRM_CHECKOUT' : 'ASK_MORE_ITEMS');
      emitTurn(reply, outcome('BASKET_REVIEWED', ['basket_state_loaded'], ['load_basket'], 'ORDER'));
      this.hooks.speak(reply, ctrl);
      return;
    }

    if (this.stage === 'ORDER' && this.memory.pending?.type === 'ASK_MORE_ITEMS' && isDoneAfterMorePrompt(text)) {
      this.recordEvent('DECISION_MADE', {
        goal: this.fsm('CHECKOUT'),
        heard: text,
        reply: 'NO_MORE_ITEMS_CHECKOUT',
        latencyMs: Date.now() - started,
      });
      this.setDesk('CHECKOUT');
      this.memory.state = 'CHECKOUT';
      this.setPending('CONFIRM_CHECKOUT');
      text = 'bhej do';
      frame.act = 'CHECKOUT';
    }

    if (frame.act === 'ADD_OR_CHANGE_ITEMS') await clearPendingAddress(this.call, this.channel);

    const agentText = careCallTextForAgent(frame, this.call.dueItems, text);
    const handoffTools = ['conversation_handle', 'catalogue_resolver', 'payment_link_if_checkout'];
    const mayCheckout = frame.act === 'ORDER_ACCEPTED' || frame.act === 'CHECKOUT' || wantsCheckout(text);
    let streamed = false;
    const agentSpeech = mayCheckout ? undefined : this.hooks.agentSpeech?.(ctrl);
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
          if (agentSpeech) {
            streamed = true;
            agentSpeech.say(`${sentence} `);
          }
        },
      },
    ).finally(() => {
      if (agentSpeech) setTimeout(() => agentSpeech.close(), 4000);
    });

    if (ctrl.signal.aborted) return;

    const said = replies.map((r) => r.text).filter(Boolean).join(' ') || 'Theek hai ji.';
    this.lastPrompt = said;
    if (isCheckoutReceipt(said)) {
      await clearPendingAddress(this.call, this.channel);
      let receiptSent = false;
      if (this.hooks.sendReceipt) {
        try {
          const receipt = await this.hooks.sendReceipt(said);
          receiptSent = true;
          handoffTools.push('whatsapp_receipt');
          this.recordEvent('TOOL_EXECUTED', {
            goal: this.fsm('CHECKOUT'),
            heard: text,
            reply: `whatsapp_receipt_sent${receipt?.sid ? ` sid=${receipt.sid}` : ''}${receipt?.status ? ` status=${receipt.status}` : ''}`,
            latencyMs: Date.now() - started,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown whatsapp receipt failure';
          handoffTools.push('whatsapp_receipt_failed');
          this.recordEvent('TOOL_FAILED', {
            goal: this.fsm('CHECKOUT'),
            heard: text,
            reply: message,
            latencyMs: Date.now() - started,
          });
        }
      }
      const postCheckoutReply = receiptSent
        ? 'Aapke WhatsApp par bill aur payment link bhej diya hai. Agar aapko kuch aur chahiye to bataiye.'
        : 'Order aur payment link ban gaya hai, lekin WhatsApp par bill bhejne mein issue aaya. Agar aapko kuch aur chahiye to bataiye.';
      this.lastPrompt = postCheckoutReply;
      this.setDesk('CHECKOUT');
      this.memory.state = 'POST_CHECKOUT';
      this.setPending('POST_CHECKOUT_MORE');
      const postCheckoutOutcome = outcome(
        receiptSent ? 'WHATSAPP_RECEIPT_SENT' : 'WHATSAPP_RECEIPT_FAILED',
        ['checkout_receipt_created'],
        handoffTools,
        'POST_CHECKOUT',
      );
      this.stage = 'POST_CHECKOUT';
      emitTurn(postCheckoutReply, postCheckoutOutcome, { persist: false, agentText });
      this.hooks.speak(postCheckoutReply, ctrl);
      return;
    }
    const handoffOutcome = outcome(
      'ORDER_ENGINE_HANDOFF',
      ['intent_detected', 'conversation_state_loaded'],
      handoffTools,
      'ORDER',
    );
    this.hooks.onLog?.('care-call turn', { heard: text, agentText, said, channel: this.channel });
    if (asksForMoreItems(said)) this.setPending('ASK_MORE_ITEMS');
    else this.memory.pending = null;
    emitTurn(said, handoffOutcome, { persist: false, agentText });
    if (!streamed) this.hooks.speak(said.split('\n\n')[0] || said, ctrl);
  }

  private recordOutcome(outcome: CareCallOutcome, heard: string, reply: string, latencyMs: number) {
    this.recordEvent('OUTCOME_READY', {
      goal: `${this.fsm('ORCHESTRATOR')}.${outcome.nextStage}`,
      heard,
      reply: `${outcome.name}; tools=${outcome.tools.join('|') || 'none'}`,
      latencyMs,
    });
    this.recordEvent('RESPONSE_GENERATED', {
      goal: this.fsm('RESPONSE_ENGINE'),
      heard,
      reply,
      latencyMs,
    });
  }

  private recordEvent(name: string, event: {
    heard?: string;
    reply?: string | null;
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
          desk: this.memory.desk,
          act: event.act ?? name,
          goal: event.goal ?? this.stage,
          heard: event.heard ? `[${++this.eventSeq}] ${event.heard}`.slice(0, 500) : `[${++this.eventSeq}]`,
          reply: `${this.memory.state}${this.memory.pending ? `/${this.memory.pending.type}` : ''}: ${event.reply ?? ''}`
            .split('\n')[0]
            .slice(0, 300),
          latencyMs: event.latencyMs ?? 0,
        },
      })
      .catch((err) => this.hooks.onLog?.('care-call event write failed', { err }));
  }

  private fsm(node: string) {
    return `ACTIVE_CALL.${this.memory.desk}.${this.memory.state}.${node}`;
  }

  private beginUserTurn() {
    this.memory.turn += 1;
    if (!this.memory.pending) return;
    this.memory.pending.expiresAfterTurns -= 1;
    if (this.memory.pending.expiresAfterTurns <= 0) this.memory.pending = null;
  }

  private setDesk(desk: CareDesk) {
    if (this.memory.desk !== desk) this.memory.previousDesk = this.memory.desk;
    this.memory.desk = desk;
  }

  private setPending(type: MemoryPending['type'], product: string | null = null, quantity: number | null = null) {
    this.memory.pending = { type, product, quantity, expiresAfterTurns: 3 };
    if (product) this.memory.referents.lastProduct = product;
  }

  private memorySnapshot(): ConversationFrame {
    return {
      desk: this.memory.desk,
      previousDesk: this.memory.previousDesk,
      state: this.memory.state,
      turn: this.memory.turn,
      pending: this.memory.pending ? { ...this.memory.pending } : null,
      referents: {
        lastProduct: this.memory.referents.lastProduct,
        lastOptions: [...this.memory.referents.lastOptions],
        lastOrderRef: this.memory.referents.lastOrderRef,
      },
      lastBotQuestion: this.memory.lastBotQuestion,
    };
  }
}

function outcome(
  name: CareCallOutcome['name'],
  preconditions: string[],
  tools: string[],
  nextStage: CareCallOutcome['nextStage'],
): CareCallOutcome {
  return { name, preconditions, tools, nextStage, verified: true };
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

async function clearPendingAddress(call: PendingCareCall, channel: CareCallChannel) {
  const convo = await loadConvo(channel, toE164(call.householdPhone), call.householdId, call.kiranaId);
  if (convo.pending?.kind !== 'ADDRESS') return;
  convo.pending = null;
  await save(convo, { householdId: call.householdId, kiranaId: call.kiranaId });
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

function readTerminalAct(text: string): CareCallFrame | null {
  if (!/\b(call\s*(cut|kat|kaat)|phone\s*(rakho|rakh|kaat|kat)|band\s*(kar|karo|kijiye)|bye|goodbye)\b/i.test(text)) {
    return null;
  }
  return {
    act: 'PERMISSION_DENIED',
    confidence: 1,
    orderText: null,
    question: null,
  };
}

function readSemanticNegative(
  text: string,
  memory: ConversationFrame,
): { action: 'NO_MORE_ITEMS' | 'REJECT_PRODUCT' | 'CHECKOUT_REJECTED' | 'CANCEL_ORDER' | 'CORRECT_PREVIOUS_ACTION' } | null {
  if (!/\b(nahi|nahin|no|mat|hata|remove|without|except|cancel|galat|wrong)\b/i.test(text)) return null;
  if (/\b(cancel|radd|rad|order cancel|poora order|sara order|saara order)\b/i.test(text)) return { action: 'CANCEL_ORDER' };
  if (/\b(nahi|nahin|no|bas|itna hi|aur kuch nahi|kuch nahi)\b/i.test(text) && memory.pending?.type === 'ASK_MORE_ITEMS') {
    return { action: 'NO_MORE_ITEMS' };
  }
  if (/\b(nahi|nahin|no|mat)\b/i.test(text) && memory.pending?.type === 'CONFIRM_CHECKOUT') {
    return { action: 'CHECKOUT_REJECTED' };
  }
  if (/\b(do|teen|char|paanch|ek|kilo|kg|packet|pack|litre|liter|ltr|quantity|qty)\b/i.test(text)) {
    return { action: 'CORRECT_PREVIOUS_ACTION' };
  }
  if (/\b(atta|aata|sugar|chini|chinni|rice|chawal|oil|tel|tea|chai|dal|daal|namkeen|biscuit)\b/i.test(text)) {
    return { action: 'REJECT_PRODUCT' };
  }
  return null;
}

function isCheckoutReceipt(text: string): boolean {
  return /(^|\n|\s)Total:?\s*Rs\s*\d/i.test(text)
    && (/(^|\n|\s)Pay:?\s*https?:\/\//i.test(text) || /Saamaan aane par de dijiye/i.test(text))
    && /\(#[a-z0-9-]{4,}\)/i.test(text);
}

function isDoneAfterCheckout(text: string): boolean {
  return /\b(nahi|nahin|no|bas|itna hi|aur kuch nahi|kuch nahi|done|thank|thanks|shukriya|dhanyavaad)\b/i.test(text);
}

function isDoneAfterMorePrompt(text: string): boolean {
  return /\b(nahi|nahin|no|bas|itna hi|aur kuch nahi|kuch nahi|done)\b/i.test(text);
}

function asksForMoreItems(text: string): boolean {
  return /\b(aur kuch|kuch aur|aur kya|anything else|what else|filhaal itna)\b/i.test(text);
}
