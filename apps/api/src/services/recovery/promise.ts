import { z } from 'zod';
import { groq } from '../../lib/groq.js';
import { env } from '../../config/env.js';

const interpretationSchema = z.object({
  understood: z.boolean(),
  promisedFor: z.string().datetime().nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(240),
}).strict();

export interface PaymentPromiseInterpretation {
  promisedFor: string;
  expiresAt: string;
  confidence: number;
  status: 'PROPOSED' | 'CONFIRMED';
  source: 'DETERMINISTIC' | 'LLM';
  rationale: string;
}

function atLocal(now: Date, dayOffset: number, hour: number, minute = 0): Date {
  const local = new Date(now.getTime() + 330 * 60_000);
  const utc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset, hour, minute) - 330 * 60_000;
  return new Date(utc);
}

function deterministic(text: string, now: Date): PaymentPromiseInterpretation | null {
  const normalized = text.toLowerCase().replace(/[^a-z0-9:\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const dayOffset = /\bparso\b/.test(normalized) ? 2 : /\bkal\b|\btomorrow\b/.test(normalized) ? 1 : /\baaj\b|\btoday\b/.test(normalized) ? 0 : null;
  const namedHour = /\bsubah\b|\bmorning\b/.test(normalized) ? 10 : /\bdopahar\b|\bafternoon\b/.test(normalized) ? 14 : /\bshaam\b|\bevening\b/.test(normalized) ? 18 : /\braat\b|\bnight\b/.test(normalized) ? 20 : null;
  const clock = normalized.match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\b/);
  let hour = namedHour;
  let minute = 0;
  if (clock) {
    hour = Number(clock[1]); minute = Number(clock[2] ?? 0);
    if (clock[3] === 'pm' && hour < 12) hour += 12;
    if (clock[3] === 'am' && hour === 12) hour = 0;
  }
  if (dayOffset === null || hour === null) return null;
  const promised = atLocal(now, dayOffset, hour, minute);
  if (promised.getTime() <= now.getTime()) return null;
  const confidence = namedHour !== null && dayOffset !== null ? 0.94 : 0.86;
  return { promisedFor: promised.toISOString(), expiresAt: new Date(promised.getTime() + 2 * 60 * 60_000).toISOString(), confidence, status: 'CONFIRMED', source: 'DETERMINISTIC', rationale: 'Explicit relative day and time window were present in the customer text.' };
}

export async function interpretPaymentPromise(text: string, now = new Date()): Promise<PaymentPromiseInterpretation> {
  const exact = deterministic(text, now);
  if (exact) return exact;
  const completion = await groq.chat.completions.create({
    model: env.GROQ_LLM_MODEL_FAST,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'Extract a payment promise from Indian English or Roman Hinglish. Return JSON only with understood, promisedFor as an ISO-8601 timestamp with timezone or null, confidence 0..1, and short rationale. Never infer a date when the customer did not commit to one. You interpret language only; you do not approve collection.' },
      { role: 'user', content: JSON.stringify({ now: now.toISOString(), timezone: 'Asia/Kolkata', text }) },
    ],
  });
  const parsed = interpretationSchema.parse(JSON.parse(completion.choices[0]?.message.content ?? '{}'));
  if (!parsed.understood || !parsed.promisedFor) throw new Error('The message does not contain a sufficiently specific payment promise');
  const promised = new Date(parsed.promisedFor);
  if (!Number.isFinite(promised.getTime()) || promised.getTime() <= now.getTime() || promised.getTime() > now.getTime() + 90 * 24 * 60 * 60_000) throw new Error('The interpreted promise time is outside the accepted future window');
  return { promisedFor: promised.toISOString(), expiresAt: new Date(promised.getTime() + 2 * 60 * 60_000).toISOString(), confidence: parsed.confidence, status: parsed.confidence >= 0.8 ? 'CONFIRMED' : 'PROPOSED', source: 'LLM', rationale: parsed.rationale };
}
