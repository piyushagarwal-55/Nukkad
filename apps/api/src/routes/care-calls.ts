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
import { speak } from '../services/voice/tts.js';
import { openEar } from '../services/asr/realtime.js';
import { openMouth } from '../services/voice/mouth.js';
import { pcm16ToMuLaw, muLawToPcm16, resamplePcm16 } from '../services/voice/twilio-codec.js';
import { readCareCallReply, type CareCallStage } from '../services/care-call/intent.js';

const callSchema = z.object({
  householdId: z.string().optional(),
  to: z.string().optional(),
  days: z.coerce.number().int().min(1).max(30).default(5),
});

const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
const CARE_CALL_AUDIO_DIR = join(process.cwd(), 'media', 'care-calls');
const SARVAM_TTS_RATE = 24_000;
const TWILIO_RATE = 8_000;
const SARVAM_ASR_RATE = 16_000;

interface PendingCareCall {
  householdId: string;
  householdName: string;
  householdPhone: string;
  shopName: string;
  shopPhone: string;
  dueItems: string[];
  permissionScript: string;
  contextScript: string;
  openingScript: string;
}

const pendingCareCalls = new Map<string, PendingCareCall>();

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
  householdId: string;
  householdName: string;
  householdPhone: string;
  shopName: string;
  shopPhone: string;
  dueItems: string[];
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

    function speakToCall(text: string, ctrl: AbortController, onDone?: () => void) {
      const mouth = openMouth({
        onAudio: (b64) => {
          if (!ctrl.signal.aborted) sendCallAudio(b64);
        },
        onDone: () => {
          setTimeout(() => mouth.close(), 250);
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
      inFlight?.abort();
      inFlight = ctrl;
      speakToCall(text, ctrl, () => setTimeout(() => socket.close(), 900));
    }

    const ear = openEar({
      onSpeechStart: () => {
        inFlight?.abort();
        clearCallAudio();
      },
      onFinal: (text) => startTurn(text),
      onError: (message, fatal) => app.log.warn({ message, fatal }, 'twilio sarvam asr'),
      onClose: () => app.log.info({ streamSid }, 'twilio sarvam ear closed'),
    });

    function startTurn(text: string) {
      if (busy || !text.trim() || !call) return;
      busy = true;

      const ctrl = new AbortController();
      inFlight?.abort();
      inFlight = ctrl;

      void runTurn(text, ctrl).finally(() => {
        busy = false;
        if (inFlight === ctrl) inFlight = null;
      });
    }

    async function runTurn(text: string, ctrl: AbortController) {
      if (!call) return;
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

      if (stage === 'PERMISSION') {
        if (frame.act === 'PERMISSION_DENIED') {
          closeAfter('Theek hai ji, main baad mein pooch lungi. Dhanyavaad.');
          return;
        }

        if (frame.act === 'PERMISSION_GRANTED') {
          stage = 'ORDER';
          speakToCall(call.contextScript, ctrl);
          return;
        }

        if (frame.act === 'ADD_OR_CHANGE_ITEMS') {
          stage = 'ORDER';
        } else {
          speakToCall('Maaf kijiye, kya main order ke baare mein do minute baat kar sakti hoon?', ctrl);
          return;
        }
      }

      if (stage === 'ORDER' && frame.act === 'ORDER_DECLINED') {
        closeAfter('Theek hai ji. Koi baat nahi. Dhanyavaad.');
        return;
      }

      const textForAgent = frame.act === 'ORDER_ACCEPTED'
        ? `${call.dueItems.join(', ')} bhej do`
        : (frame.orderText?.trim() || text);

      const replies = await handle({
        channel: 'twilio',
        senderId: toE164(call.householdPhone),
        recipientId: toE164(call.shopPhone),
        text: textForAgent,
        media: [],
        externalId: `twilio_stream_${streamSid ?? randomUUID()}_${Date.now()}`,
        receivedAt: new Date(),
      });

      if (ctrl.signal.aborted) return;

      const said = replies.map((r) => r.text).filter(Boolean).join(' ') || 'Theek hai ji.';
      app.log.info({ heard: text, agentText: textForAgent, said, streamSid }, 'twilio stream turn');
      speakToCall(said, ctrl);
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
          householdName: 'ji',
          householdPhone: params.householdPhone ?? '',
          shopName: 'Sunita Kirana Store',
          shopPhone: params.shopPhone ?? env.TWILIO_WHATSAPP_FROM.replace('whatsapp:', ''),
          dueItems: [],
          permissionScript: 'Namaste ji, main Sunita Kirana Store se bol rahi hoon. Kya main aapse order ke baare mein do minute baat kar sakti hoon?',
          contextScript: 'Aapke kuch regular items due lag rahe hain. Kya main order bana doon?',
          openingScript: 'Namaste ji, main Sunita Kirana Store se bol rahi hoon. Kya main aapse order ke baare mein do minute baat kar sakti hoon?',
        };
        pendingCareCalls.delete(params.sessionId ?? '');

        const ctrl = new AbortController();
        inFlight = ctrl;
        stage = 'PERMISSION';
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
        inFlight?.abort();
        ear.close();
      }
    });

    socket.on('close', () => {
      inFlight?.abort();
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
        householdId: plan.household.id,
        householdName: plan.household.name,
        householdPhone: plan.household.phone,
        shopName: plan.shop.name,
        shopPhone: env.TWILIO_WHATSAPP_FROM.replace('whatsapp:', ''),
        dueItems: plan.lines.map((line) => line.name),
        permissionScript: `Namaste ${plan.household.name} ji, main ${plan.shop.name} se bol rahi hoon. Kya main aapse order ke baare mein do minute baat kar sakti hoon?`,
        contextScript: plan.openingScript
          .replace(/^Namaste .*? se bol rahi hoon\. /, '')
          .replace(/^Agar aap free ho to kya main aapse 2 minute baat kar sakti hoon\? /, ''),
        openingScript: plan.openingScript,
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
      channel: 'twilio',
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
