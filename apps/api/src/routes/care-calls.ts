import type { FastifyInstance } from 'fastify';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import twilio from 'twilio';
import { z } from 'zod';
import { prisma } from '@nukkad/db';
import { requireSession } from './auth.js';
import { buildCareCallPlans } from '../services/care-call/plan.js';
import { env } from '../config/env.js';
import { toE164 } from '../lib/phone.js';
import { handle } from '../services/conversation/core.js';
import { loadConvo, save, type PendingLine } from '../services/conversation/state.js';
import { orderCard } from '../services/conversation/messages.js';
import { speak } from '../services/voice/tts.js';
import { openEar } from '../services/asr/realtime.js';
import { openMouth } from '../services/voice/mouth.js';
import { voiceFor } from '../services/voice/voices.js';
import type { Desk } from '../services/policy/desks.js';
import { pcm16ToMuLaw, muLawToPcm16, resamplePcm16 } from '../services/voice/twilio-codec.js';
import {
  readCareCallReply,
  type CareCallFrame,
  type CareCallStage,
} from '../services/care-call/intent.js';

const callSchema = z.object({
  householdId: z.string().optional(),
  to: z.string().optional(),
  days: z.coerce.number().int().min(1).max(30).default(5),
});

const testSessionSchema = z.object({
  householdId: z.string().optional(),
  days: z.coerce.number().int().min(1).max(30).default(14),
});

const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
const CARE_CALL_AUDIO_DIR = join(process.cwd(), 'media', 'care-calls');
const SARVAM_TTS_RATE = 24_000;
const TWILIO_RATE = 8_000;
const SARVAM_ASR_RATE = 16_000;
const CARE_CALL_FINAL_DEBOUNCE_MS = 900;

interface PendingCareCall {
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

const pendingCareCalls = new Map<string, PendingCareCall>();

/**
 * Keep the customer's complete correction intact when handing a care-call
 * turn to the shared conversation engine. The classifier decides routing;
 * it must never rewrite away commands such as "mat add karna".
 */
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
      return hits >= Math.min(2, words.length) || words.some((word) => heardWords.has(word) && ['atta', 'sugar', 'rice', 'oil'].includes(word));
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

async function pendingFromPlan(kiranaId: string, plan: Awaited<ReturnType<typeof buildCareCallPlans>>[number]): Promise<PendingCareCall> {
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

async function seedCareCallBasket(call: PendingCareCall, channel: 'care-call' | 'care-call-test') {
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

async function currentCareCallBasket(call: PendingCareCall, channel: 'care-call' | 'care-call-test') {
  const convo = await loadConvo(channel, toE164(call.householdPhone), call.householdId, call.kiranaId);
  return convo.basket;
}

function voiceFrom(): string {
  const from = env.TWILIO_VOICE_FROM ?? env.TWILIO_SMS_NUMBER;
  if (!from) throw new Error('TWILIO_VOICE_FROM or TWILIO_SMS_NUMBER is required for outbound calls');
  return from;
}

function publicBase(): string {
  if (!env.PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL is required for outbound calls');
  return env.PUBLIC_BASE_URL.replace(/\/$/, '');
}

function publicWsBase(): string {
  return publicBase().replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

function sayText(parent: { say: (attrs: Record<string, string>, text: string) => unknown }, text: string) {
  parent.say({ language: 'hi-IN', voice: 'Polly.Aditi' }, text);
}

async function sarvamAudioUrl(text: string): Promise<string | null> {
  const spoken = await speak(text);
  if (!spoken) return null;

  await mkdir(CARE_CALL_AUDIO_DIR, { recursive: true });
  const file = `${randomUUID()}.wav`;
  await writeFile(join(CARE_CALL_AUDIO_DIR, file), spoken.audio);
  return `${publicBase()}/care-calls/audio/${file}`;
}

async function playSarvamOrSay(
  parent: {
    play?: (url: string) => unknown;
    say: (attrs: Record<string, string>, text: string) => unknown;
  },
  text: string,
) {
  const url = await sarvamAudioUrl(text);
  if (url && parent.play) parent.play(url);
  else sayText(parent, text);
}

async function callTwiML(opts: {
  kiranaId: string;
  householdId: string;
  householdName: string;
  householdPhone: string;
  shopName: string;
  shopPhone: string;
  dueItems: string[];
  dueLines: PendingCareCall['dueLines'];
  permissionScript: string;
  contextScript: string;
  openingScript: string;
}) {
  const sessionId = randomUUID();
  pendingCareCalls.set(sessionId, opts);

  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect();
  const stream = connect.stream({
    url: `${publicWsBase()}/care-calls/twilio/stream`,
  });
  stream.parameter({ name: 'sessionId', value: sessionId });
  stream.parameter({ name: 'kiranaId', value: opts.kiranaId });
  stream.parameter({ name: 'householdId', value: opts.householdId });
  stream.parameter({ name: 'householdPhone', value: opts.householdPhone });
  stream.parameter({ name: 'shopPhone', value: opts.shopPhone });
  return response.toString();
}

async function replyTwiML(text: string, done = false, params: Record<string, string> = {}) {
  const response = new twilio.twiml.VoiceResponse();
  await playSarvamOrSay(response, text.slice(0, 1400));
  if (!done) {
    const gather = response.gather({
      input: ['speech'],
      action: `${publicBase()}/care-calls/twilio/answer?${new URLSearchParams(params).toString()}`,
      method: 'POST',
      language: 'hi-IN',
      speechTimeout: 'auto',
    });
    await playSarvamOrSay(gather, 'Aur kuch chahiye?');
  }
  return response.toString();
}

export async function careCallRoutes(app: FastifyInstance) {
  app.get('/care-calls/twilio/stream', { websocket: true }, (socket) => {
    let streamSid: string | null = null;
    let call: PendingCareCall | null = null;
    let stage: CareCallStage = 'PERMISSION';
    let lastPrompt = '';
    let busy = false;
    let inFlight: AbortController | null = null;
    let speaking: AbortController | null = null;
    const queuedUtterances: string[] = [];
    let finalBuffer: string[] = [];
    let finalTimer: ReturnType<typeof setTimeout> | null = null;

    const send = (msg: unknown) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(msg));
    };

    const clearCallAudio = () => {
      if (!streamSid) return;
      send({ event: 'clear', streamSid });
    };

    const sendCallAudio = (b64: string) => {
      if (!streamSid) return;
      const sarvamPcm = Buffer.from(b64, 'base64');
      const twilioPcm = resamplePcm16(sarvamPcm, SARVAM_TTS_RATE, TWILIO_RATE);
      const payload = pcm16ToMuLaw(twilioPcm).toString('base64');
      const mark = `sarvam_${randomUUID()}`;
      send({ event: 'media', streamSid, media: { payload } });
      send({ event: 'mark', streamSid, mark: { name: mark } });
    };

    const saveCallEvent = (event: {
      heard: string;
      reply: string | null;
      act?: string | null;
      goal?: string | null;
      latencyMs?: number;
    }) => {
      if (!call?.kiranaId || !call.householdId) return;
      void prisma.agentEvent
        .create({
          data: {
            kiranaId: call.kiranaId,
            householdId: call.householdId,
            channel: 'care-call',
            desk: 'CARE_CALL',
            act: event.act ?? null,
            goal: event.goal ?? stage,
            heard: event.heard.slice(0, 500),
            reply: event.reply?.split('\n')[0]?.slice(0, 300) ?? null,
            latencyMs: event.latencyMs ?? 0,
          },
        })
        .catch((err) => app.log.warn({ err }, 'care-call event write failed'));
    };

    const rememberBotPrompt = (text: string, act = 'BOT_PROMPT') => {
      saveCallEvent({ heard: '', reply: text, act, goal: stage });
    };

    function speakToCall(text: string, ctrl: AbortController, onDone?: () => void) {
      const speech = new AbortController();
      speaking?.abort();
      speaking = speech;
      const mouth = openMouth({
        onAudio: (b64) => {
          if (!ctrl.signal.aborted && !speech.signal.aborted) sendCallAudio(b64);
        },
        onDone: () => {
          setTimeout(() => mouth.close(), 250);
          if (speaking === speech) speaking = null;
          if (ctrl.signal.aborted || speech.signal.aborted) return;
          onDone?.();
        },
        onError: (message) => app.log.warn({ message }, 'twilio tts stream'),
      });
      lastPrompt = text;
      mouth.say(text);
      mouth.flush();
    }

    function closeAfter(text: string) {
      const ctrl = new AbortController();
      speakToCall(text, ctrl, () => setTimeout(() => {
        if (!ctrl.signal.aborted) socket.close();
      }, 900));
    }

    const ear = openEar({
      onSpeechStart: () => {
        inFlight?.abort();
        speaking?.abort();
        speaking = null;
        clearCallAudio();
      },
      onFinal: (text) => queueFinal(text),
      onError: (message, fatal) => app.log.warn({ message, fatal }, 'twilio sarvam asr'),
      onClose: () => app.log.info({ streamSid }, 'twilio sarvam ear closed'),
    });

    function queueFinal(text: string) {
      if (!text.trim()) return;
      if (stage !== 'ORDER') {
        startTurn(text);
        return;
      }
      finalBuffer.push(text);
      if (finalTimer) clearTimeout(finalTimer);
      finalTimer = setTimeout(() => {
        const merged = finalBuffer.join(' ').trim();
        finalBuffer = [];
        finalTimer = null;
        startTurn(merged);
      }, CARE_CALL_FINAL_DEBOUNCE_MS);
    }

    function startTurn(text: string) {
      if (!text.trim() || !call) return;
      if (busy) {
        queuedUtterances.push(text);
        return;
      }
      busy = true;

      const ctrl = new AbortController();
      inFlight = ctrl;

      void runTurn(text, ctrl).finally(() => {
        busy = false;
        if (inFlight === ctrl) inFlight = null;
        const next = queuedUtterances.shift()?.trim();
        if (next) startTurn(next);
      });
    }

    async function runTurn(text: string, ctrl: AbortController) {
      if (!call) return;
      const started = Date.now();
      const frame = await readCareCallReply({
        stage,
        text,
        customerName: call.householdName,
        shopName: call.shopName,
        dueItems: call.dueItems,
        lastPrompt,
      });

      app.log.info({ heard: text, frame, stage, streamSid }, 'twilio care-call intent');

      if (ctrl.signal.aborted) return;

      const saveStageTurn = (reply: string) => {
        saveCallEvent({
          heard: text,
          reply,
          act: frame.act,
          goal: stage,
          latencyMs: Date.now() - started,
        });
      };

      if (stage === 'PERMISSION') {
        if (frame.act === 'PERMISSION_DENIED') {
          const reply = 'Theek hai ji, main baad mein pooch lungi. Dhanyavaad.';
          saveStageTurn(reply);
          closeAfter(reply);
          return;
        }

        if (frame.act === 'PERMISSION_GRANTED') {
          await seedCareCallBasket(call, 'care-call');
          saveStageTurn(call.contextScript);
          stage = 'ORDER';
          speakToCall(call.contextScript, ctrl);
          return;
        }

        if (frame.act === 'ADD_OR_CHANGE_ITEMS') {
          await seedCareCallBasket(call, 'care-call');
          stage = 'ORDER';
        } else {
          const reply = 'Maaf kijiye, kya main order ke baare mein do minute baat kar sakti hoon?';
          saveStageTurn(reply);
          speakToCall(reply, ctrl);
          return;
        }
      }

      if (stage === 'ORDER' && frame.act === 'ORDER_DECLINED') {
        const reply = 'Theek hai ji. Koi baat nahi. Dhanyavaad.';
        saveStageTurn(reply);
        closeAfter(reply);
        return;
      }

      if (stage === 'ORDER' && (frame.act === 'ASK_QUESTION' || wantsBasketReadback(text)) && wantsBasketReadback(text)) {
        const basket = await currentCareCallBasket(call, 'care-call');
        const reply = basket.length
          ? `Abhi order mein ye hai:\n\n${orderCard(basket)}\n\nBhej dun?`
          : 'Abhi order khali hai. Bataiye kya chahiye?';
        saveStageTurn(reply);
        speakToCall(reply, ctrl);
        return;
      }

      const textForAgent = careCallTextForAgent(frame, call.dueItems, text);

      const speech = new AbortController();
      speaking?.abort();
      speaking = speech;
      let streamed = false;
      const mouth = openMouth({
        onAudio: (b64) => {
          if (!ctrl.signal.aborted && !speech.signal.aborted) sendCallAudio(b64);
        },
        onDone: () => undefined,
        onError: (message) => app.log.warn({ message }, 'twilio tts stream'),
      });

      const replies = await (async () => {
        try {
          return await handle(
            {
              channel: 'care-call',
              senderId: toE164(call.householdPhone),
              recipientId: toE164(call.shopPhone),
              text: textForAgent,
              media: [],
              externalId: `twilio_stream_${streamSid ?? randomUUID()}_${Date.now()}`,
              receivedAt: new Date(),
            },
            {
              onDesk: (desk: Desk) => mouth.setSpeaker(voiceFor(desk)),
              onSentence: (sentence) => {
                streamed = true;
                mouth.say(`${sentence} `);
                mouth.flush();
              },
            },
          );
        } finally {
          setTimeout(() => {
            mouth.close();
            if (speaking === speech) speaking = null;
          }, 4000);
        }
      })();

      if (ctrl.signal.aborted) return;

      const said = replies.map((r) => r.text).filter(Boolean).join(' ') || 'Theek hai ji.';
      app.log.info({ heard: text, agentText: textForAgent, said, streamSid }, 'twilio stream turn');
      lastPrompt = said;
      if (!streamed) speakToCall(said.split('\n\n')[0] || said, ctrl);
    }

    socket.on('message', (data: Buffer) => {
      let msg: {
        event?: string;
        streamSid?: string;
        start?: {
          streamSid?: string;
          customParameters?: Record<string, string>;
        };
        media?: { payload?: string };
      };

      try {
        msg = JSON.parse(data.toString()) as typeof msg;
      } catch {
        return;
      }

      if (msg.event === 'start') {
        streamSid = msg.start?.streamSid ?? msg.streamSid ?? null;
        const params = msg.start?.customParameters ?? {};
        call = pendingCareCalls.get(params.sessionId ?? '') ?? {
          householdId: params.householdId ?? '',
          kiranaId: params.kiranaId ?? '',
          householdName: 'ji',
          householdPhone: params.householdPhone ?? '',
          shopName: 'Sunita Kirana Store',
          shopPhone: params.shopPhone ?? env.TWILIO_WHATSAPP_FROM.replace('whatsapp:', ''),
          dueItems: [],
          dueLines: [],
          permissionScript: 'Namaste ji, main Sunita Kirana Store se bol rahi hoon. Kya main aapse order ke baare mein do minute baat kar sakti hoon?',
          contextScript: 'Aapke kuch regular items due lag rahe hain. Kya main order bana doon?',
          openingScript: 'Namaste ji, main Sunita Kirana Store se bol rahi hoon. Kya main aapse order ke baare mein do minute baat kar sakti hoon?',
        };
        pendingCareCalls.delete(params.sessionId ?? '');

        const ctrl = new AbortController();
        inFlight = ctrl;
        stage = 'PERMISSION';
        rememberBotPrompt(call.permissionScript, 'CALL_OPENED');
        speakToCall(call.permissionScript, ctrl);
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        const muLaw = Buffer.from(msg.media.payload, 'base64');
        const pcm8k = muLawToPcm16(muLaw);
        ear.send(resamplePcm16(pcm8k, TWILIO_RATE, SARVAM_ASR_RATE));
        return;
      }

      if (msg.event === 'stop') {
        if (finalTimer) clearTimeout(finalTimer);
        inFlight?.abort();
        speaking?.abort();
        ear.close();
      }
    });

    socket.on('close', () => {
      if (finalTimer) clearTimeout(finalTimer);
      inFlight?.abort();
      speaking?.abort();
      ear.close();
    });
  });

  app.get('/care-calls/test/stream', { websocket: true }, (socket) => {
    let call: PendingCareCall | null = null;
    let stage: CareCallStage = 'PERMISSION';
    let lastPrompt = '';
    let busy = false;
    let inFlight: AbortController | null = null;
    let speaking: AbortController | null = null;
    const queuedUtterances: string[] = [];
    let finalBuffer: string[] = [];
    let finalTimer: ReturnType<typeof setTimeout> | null = null;

    const send = (msg: unknown) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(msg));
    };

    const saveCallEvent = (event: {
      heard: string;
      reply: string | null;
      act?: string | null;
      goal?: string | null;
      latencyMs?: number;
    }) => {
      if (!call?.kiranaId || !call.householdId) return;
      void prisma.agentEvent
        .create({
          data: {
            kiranaId: call.kiranaId,
            householdId: call.householdId,
            channel: 'care-call-test',
            desk: 'CARE_CALL',
            act: event.act ?? null,
            goal: event.goal ?? stage,
            heard: event.heard.slice(0, 500),
            reply: event.reply?.split('\n')[0]?.slice(0, 300) ?? null,
            latencyMs: event.latencyMs ?? 0,
          },
        })
        .catch((err) => app.log.warn({ err }, 'care-call test event write failed'));
    };

    function speakToBrowser(text: string, ctrl: AbortController, onDone?: () => void) {
      const speech = new AbortController();
      speaking?.abort();
      speaking = speech;
      lastPrompt = text;
      const mouth = openMouth({
        onAudio: (b64) => {
          if (!ctrl.signal.aborted && !speech.signal.aborted) send({ type: 'audio', b64 });
        },
        onDone: () => {
          setTimeout(() => mouth.close(), 250);
          if (speaking === speech) speaking = null;
          if (ctrl.signal.aborted || speech.signal.aborted) return;
          onDone?.();
        },
        onError: (message) => send({ type: 'error', message }),
      });
      mouth.say(text);
      mouth.flush();
    }

    function closeAfter(text: string) {
      const ctrl = new AbortController();
      speakToBrowser(text, ctrl, () => {
        if (!ctrl.signal.aborted) send({ type: 'closed' });
      });
    }

    const ear = openEar({
      onSpeechStart: () => {
        inFlight?.abort();
        speaking?.abort();
        speaking = null;
        send({ type: 'listening' });
      },
      onPartial: (text) => send({ type: 'partial', text }),
      onSpeechEnd: () => send({ type: 'thinking' }),
      onFinal: (text) => queueFinal(text),
      onError: (message, fatal) => send({ type: 'error', message, fatal }),
      onClose: () => send({ type: 'ear-closed' }),
    });

    function queueFinal(text: string) {
      if (!text.trim()) return;
      if (stage !== 'ORDER') {
        startTurn(text);
        return;
      }
      finalBuffer.push(text);
      if (finalTimer) clearTimeout(finalTimer);
      finalTimer = setTimeout(() => {
        const merged = finalBuffer.join(' ').trim();
        finalBuffer = [];
        finalTimer = null;
        startTurn(merged);
      }, CARE_CALL_FINAL_DEBOUNCE_MS);
    }

    function startTurn(text: string) {
      if (!text.trim() || !call) return;
      if (busy) {
        queuedUtterances.push(text);
        return;
      }
      busy = true;

      const ctrl = new AbortController();
      inFlight = ctrl;

      void runTurn(text, ctrl).finally(() => {
        busy = false;
        if (inFlight === ctrl) inFlight = null;
        const next = queuedUtterances.shift()?.trim();
        if (next) startTurn(next);
      });
    }

    async function runTurn(text: string, ctrl: AbortController) {
      if (!call) return;
      const started = Date.now();
      const frame = await readCareCallReply({
        stage,
        text,
        customerName: call.householdName,
        shopName: call.shopName,
        dueItems: call.dueItems,
        lastPrompt,
      });

      app.log.info({ heard: text, frame, stage }, 'browser care-call intent');
      if (ctrl.signal.aborted) return;

      const sendTurn = (reply: string, opts: { persist?: boolean } = {}) => {
        const turn = {
          type: 'turn',
          stage,
          heard: text,
          reply,
          action: frame.act,
          totalMs: Date.now() - started,
        };
        if (opts.persist !== false) {
          saveCallEvent({
            heard: text,
            reply,
            act: frame.act,
            goal: stage,
            latencyMs: Date.now() - started,
          });
        }
        send(turn);
      };

      if (stage === 'PERMISSION') {
        if (frame.act === 'PERMISSION_DENIED') {
          const reply = 'Theek hai ji, main baad mein pooch lungi. Dhanyavaad.';
          sendTurn(reply);
          closeAfter(reply);
          return;
        }

        if (frame.act === 'PERMISSION_GRANTED') {
          await seedCareCallBasket(call, 'care-call-test');
          sendTurn(call.contextScript);
          stage = 'ORDER';
          speakToBrowser(call.contextScript, ctrl);
          return;
        }

        if (frame.act === 'ADD_OR_CHANGE_ITEMS') {
          await seedCareCallBasket(call, 'care-call-test');
          stage = 'ORDER';
        } else {
          const reply = 'Maaf kijiye, kya main order ke baare mein do minute baat kar sakti hoon?';
          sendTurn(reply);
          speakToBrowser(reply, ctrl);
          return;
        }
      }

      if (stage === 'ORDER' && frame.act === 'ORDER_DECLINED') {
        const reply = 'Theek hai ji. Koi baat nahi. Dhanyavaad.';
        sendTurn(reply);
        closeAfter(reply);
        return;
      }

      if (stage === 'ORDER' && (frame.act === 'ASK_QUESTION' || wantsBasketReadback(text)) && wantsBasketReadback(text)) {
        const basket = await currentCareCallBasket(call, 'care-call-test');
        const reply = basket.length
          ? `Abhi order mein ye hai:\n\n${orderCard(basket)}\n\nBhej dun?`
          : 'Abhi order khali hai. Bataiye kya chahiye?';
        sendTurn(reply);
        speakToBrowser(reply, ctrl);
        return;
      }

      const textForAgent = careCallTextForAgent(frame, call.dueItems, text);

      const speech = new AbortController();
      speaking?.abort();
      speaking = speech;
      let streamed = false;
      const mouth = openMouth({
        onAudio: (b64) => {
          if (!ctrl.signal.aborted && !speech.signal.aborted) send({ type: 'audio', b64 });
        },
        onDone: () => undefined,
        onError: (message) => send({ type: 'error', message }),
      });

      const replies = await (async () => {
        try {
          return await handle(
            {
              channel: 'care-call-test',
              senderId: toE164(call.householdPhone),
              recipientId: toE164(call.shopPhone),
              text: textForAgent,
              media: [],
              externalId: `care_test_${randomUUID()}`,
              receivedAt: new Date(),
            },
            {
              onDesk: (desk: Desk) => {
                mouth.setSpeaker(voiceFor(desk));
                send({ type: 'desk', desk });
              },
              onSentence: (sentence) => {
                streamed = true;
                mouth.say(`${sentence} `);
                mouth.flush();
              },
            },
          );
        } finally {
          setTimeout(() => {
            mouth.close();
            if (speaking === speech) speaking = null;
          }, 4000);
        }
      })();

      if (ctrl.signal.aborted) return;

      const said = replies.map((r) => r.text).filter(Boolean).join(' ') || 'Theek hai ji.';
      app.log.info({ heard: text, agentText: textForAgent, said }, 'browser care-call turn');
      lastPrompt = said;
      sendTurn(said, { persist: false });
      if (!streamed) speakToBrowser(said.split('\n\n')[0] || said, ctrl);
    }

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        ear.send(data);
        return;
      }

      try {
        const msg = JSON.parse(data.toString()) as { type?: string; text?: string; sessionId?: string };
        if (msg.type === 'start' && msg.sessionId) {
          call = pendingCareCalls.get(msg.sessionId) ?? null;
          pendingCareCalls.delete(msg.sessionId);
          if (!call) {
            send({ type: 'error', message: 'Care-call test session expired. Start again.' });
            return;
          }

          const ctrl = new AbortController();
          inFlight = ctrl;
          stage = 'PERMISSION';
          saveCallEvent({ heard: '', reply: call.permissionScript, act: 'CALL_OPENED', goal: stage });
          send({ type: 'opened', household: call.householdName, prompt: call.permissionScript });
          speakToBrowser(call.permissionScript, ctrl);
          return;
        }
        if (msg.type === 'text' && typeof msg.text === 'string') startTurn(msg.text);
        if (msg.type === 'stop') {
          if (finalTimer) clearTimeout(finalTimer);
          inFlight?.abort();
          speaking?.abort();
        }
      } catch {
        // malformed control frames are ignored
      }
    });

    socket.on('close', () => {
      if (finalTimer) clearTimeout(finalTimer);
      inFlight?.abort();
      speaking?.abort();
      ear.close();
    });
  });

  app.get('/care-calls/audio/:file', async (req, reply) => {
    const file = (req.params as { file?: string }).file ?? '';
    if (!/^[a-f0-9-]+\.wav$/i.test(file)) return reply.code(404).send({ error: 'not found' });

    try {
      const audio = await readFile(join(CARE_CALL_AUDIO_DIR, file));
      return reply
        .header('content-type', 'audio/wav')
        .header('cache-control', 'public, max-age=3600')
        .send(audio);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  app.get('/care-calls/due', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const days = Number((req.query as { days?: string }).days ?? 5);
    if (!Number.isFinite(days) || days < 1 || days > 30) {
      return reply.code(400).send({ error: 'days must be between 1 and 30' });
    }

    const plans = await buildCareCallPlans(kiranaId, days);
    return {
      mode: 'outbound-care-call',
      separation:
        'This is intentionally separate from the inbound WhatsApp/order agent. It prepares a call script; it does not change conversation/core.ts.',
      plans,
    };
  });

  app.post('/care-calls/test/session', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const parsed = testSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const plans = await buildCareCallPlans(kiranaId, parsed.data.days);
    const plan = parsed.data.householdId
      ? plans.find((p) => p.household.id === parsed.data.householdId)
      : plans[0];
    if (!plan) return reply.code(404).send({ error: 'no care-call plan due for this customer' });

    const sessionId = randomUUID();
    const pending = await pendingFromPlan(kiranaId, plan);
    pendingCareCalls.set(sessionId, pending);

    return {
      ok: true,
      sessionId,
      household: plan.household,
      shop: plan.shop,
      lines: plan.lines,
      openingScript: pending.permissionScript,
      contextScript: pending.contextScript,
    };
  });

  app.post('/care-calls/call', async (req, reply) => {
    const { kiranaId } = requireSession(req);
    const parsed = callSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const plans = await buildCareCallPlans(kiranaId, parsed.data.days);
    const plan = parsed.data.householdId
      ? plans.find((p) => p.household.id === parsed.data.householdId)
      : plans[0];
    if (!plan) return reply.code(404).send({ error: 'no care-call plan due for this customer' });

    const to = toE164(parsed.data.to ?? plan.household.phone);
    const call = await client.calls.create({
      from: voiceFrom(),
      to,
      twiml: await callTwiML({
        ...(await pendingFromPlan(kiranaId, plan)),
      }),
    });

    await prisma.nudge.create({
      data: {
        householdId: plan.household.id,
        templateName: 'twilio_voice_care_call',
        predictedBasketJson: plan.lines.map((line) => ({
          skuId: line.skuId,
          name: line.name,
          quantityHint: line.quantityHint,
          reason: line.reason,
        })) as never,
      },
    });

    return { ok: true, callSid: call.sid, to, household: plan.household.name };
  });

  app.post('/care-calls/twilio/answer', async (req, reply) => {
    const q = req.query as { householdPhone?: string; shopPhone?: string };
    const body = req.body as { SpeechResult?: string; To?: string; From?: string };
    const text = body.SpeechResult?.trim();
    const params = {
      ...(q.householdPhone ? { householdPhone: q.householdPhone } : {}),
      ...(q.shopPhone ? { shopPhone: q.shopPhone } : {}),
    };

    reply.header('content-type', 'text/xml');
    if (!text) {
      return reply.send(await replyTwiML('Maaf kijiye, awaaz saaf nahi aayi. Kya samaan bhejna hai?', false, params));
    }

    const householdPhone = q.householdPhone ?? body.To;
    const shopPhone = q.shopPhone ?? env.TWILIO_WHATSAPP_FROM.replace('whatsapp:', '');
    if (!householdPhone) {
      return reply.send(await replyTwiML('Customer number nahi mila. Main order save nahi kar paayi.', true));
    }

    const replies = await handle({
      channel: 'care-call',
      senderId: toE164(householdPhone),
      recipientId: toE164(shopPhone),
      text,
      media: [],
      externalId: `voice_call_${body.From ?? ''}_${Date.now()}`,
      receivedAt: new Date(),
    });

    const said = replies.map((r) => r.text).filter(Boolean).join(' ');
    return reply.send(await replyTwiML(said || 'Theek hai ji.', /payment|paise|confirm ho gaya/i.test(said), params));
  });
}
