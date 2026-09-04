import type { FastifyInstance } from 'fastify';
import twilio from 'twilio';
import { z } from 'zod';
import { prisma } from '@nukkad/db';
import { requireSession } from './auth.js';
import { buildCareCallPlans } from '../services/care-call/plan.js';
import { env } from '../config/env.js';
import { toE164 } from '../lib/phone.js';
import { handle } from '../services/conversation/core.js';

const callSchema = z.object({
  householdId: z.string().optional(),
  to: z.string().optional(),
  days: z.coerce.number().int().min(1).max(30).default(5),
});

const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

function voiceFrom(): string {
  const from = env.TWILIO_VOICE_FROM ?? env.TWILIO_SMS_NUMBER;
  if (!from) throw new Error('TWILIO_VOICE_FROM or TWILIO_SMS_NUMBER is required for outbound calls');
  return from;
}

function publicBase(): string {
  if (!env.PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL is required for outbound calls');
  return env.PUBLIC_BASE_URL.replace(/\/$/, '');
}

function sayText(parent: { say: (attrs: Record<string, string>, text: string) => unknown }, text: string) {
  parent.say({ language: 'hi-IN', voice: 'Polly.Aditi' }, text);
}

function callTwiML(opts: {
  householdId: string;
  householdPhone: string;
  shopPhone: string;
  openingScript: string;
}) {
  const response = new twilio.twiml.VoiceResponse();
  const gather = response.gather({
    input: ['speech'],
    action: `${publicBase()}/care-calls/twilio/answer?${new URLSearchParams({
      householdId: opts.householdId,
      householdPhone: opts.householdPhone,
      shopPhone: opts.shopPhone,
    }).toString()}`,
    method: 'POST',
    language: 'hi-IN',
    speechTimeout: 'auto',
  });
  sayText(gather, opts.openingScript);
  sayText(response, 'Theek hai ji. Main baad mein dobara pooch lungi. Dhanyavaad.');
  return response.toString();
}

function replyTwiML(text: string, done = false, params: Record<string, string> = {}) {
  const response = new twilio.twiml.VoiceResponse();
  sayText(response, text.slice(0, 1400));
  if (!done) {
    const gather = response.gather({
      input: ['speech'],
      action: `${publicBase()}/care-calls/twilio/answer?${new URLSearchParams(params).toString()}`,
      method: 'POST',
      language: 'hi-IN',
      speechTimeout: 'auto',
    });
    sayText(gather, 'Aur kuch chahiye?');
  }
  return response.toString();
}

export async function careCallRoutes(app: FastifyInstance) {
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
      twiml: callTwiML({
        householdId: plan.household.id,
        householdPhone: plan.household.phone,
        shopPhone: env.TWILIO_WHATSAPP_FROM.replace('whatsapp:', ''),
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
      return reply.send(replyTwiML('Maaf kijiye, awaaz saaf nahi aayi. Kya samaan bhejna hai?', false, params));
    }

    const householdPhone = q.householdPhone ?? body.To;
    const shopPhone = q.shopPhone ?? env.TWILIO_WHATSAPP_FROM.replace('whatsapp:', '');
    if (!householdPhone) {
      return reply.send(replyTwiML('Customer number nahi mila. Main order save nahi kar paayi.', true));
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
    return reply.send(replyTwiML(said || 'Theek hai ji.', /payment|paise|confirm ho gaya/i.test(said), params));
  });
}
