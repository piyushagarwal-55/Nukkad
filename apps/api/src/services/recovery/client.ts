import { createHmac, randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

export async function sendPaymentPromise(input: { obligationId: string; channel: 'WHATSAPP' | 'SMS' | 'VOICE' | 'EMAIL'; rawText: string; promisedFor: string; expiresAt: string; confidence: number; status: 'PROPOSED' | 'CONFIRMED' }) {
  const event = { eventId: `nukkad_${randomUUID()}`, obligationId: input.obligationId, kind: 'PAYMENT_PROMISE' as const, occurredAt: new Date().toISOString(), channel: input.channel, rawText: input.rawText, promisedFor: input.promisedFor, expiresAt: input.expiresAt, confidence: input.confidence, status: input.status };
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', env.PAYCORRECT_CHANNEL_SECRET).update(`${timestamp}.`).update(stableJson(event)).digest('hex');
  const response = await fetch(`${env.PAYCORRECT_URL}/v1/recovery/channel-events`, { method: 'POST', body: JSON.stringify(event), signal: AbortSignal.timeout(5_000), headers: { 'content-type': 'application/json', 'x-pce-channel-timestamp': timestamp, 'x-pce-channel-signature': signature } });
  const body = await response.json() as unknown;
  if (!response.ok) throw new Error(`Payment Correctness rejected the promise event with HTTP ${response.status}`);
  return { event, response: body };
}
