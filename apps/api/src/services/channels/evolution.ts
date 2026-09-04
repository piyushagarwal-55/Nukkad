import { env } from '../../config/env.js';
import { twilioAdapter } from '../../channels/index.js';

/**
 * SENDING A WHATSAPP MESSAGE, from anywhere in the system.
 *
 * This used to live inside routes/evolution.ts as a closure over the
 * Fastify instance, which meant only an inbound webhook could send
 * anything -- the shop could reply to a customer and could do nothing
 * else. The supplier leg is the counter-example that forced this out:
 * ordering stock is a message the shop STARTS, with no customer message
 * to answer, from a dashboard click or a background job.
 *
 * So the transport is a service and the routes are callers, which is the
 * shape the rest of the codebase already has.
 */

export const evolutionReady = (): boolean =>
  env.NODE_ENV === 'production'
    ? Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM)
    : Boolean(env.EVOLUTION_URL && env.EVOLUTION_APIKEY);

export interface SendResult {
  ok: boolean;
  /** WhatsApp's own message id, when it gave us one */
  externalId?: string;
  error?: string;
}

/**
 * One text to one number. Never throws -- a failed send is a fact the
 * caller records, not an exception that unwinds a dashboard click.
 */
export async function sendText(to: string, text: string): Promise<SendResult> {
  if (env.NODE_ENV === 'production') {
    try {
      await twilioAdapter.send(to, { text });
      return { ok: true };
    } catch (err) {
      const e = err as Error & { code?: number | string; status?: number };
      const prefix = e.code || e.status ? `${e.code ?? e.status} ` : '';
      return { ok: false, error: `${prefix}${e.message}`.trim() };
    }
  }

  if (!evolutionReady()) return { ok: false, error: 'evolution not configured' };

  try {
    const res = await fetch(
      `${env.EVOLUTION_URL}/message/sendText/${env.EVOLUTION_INSTANCE}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: env.EVOLUTION_APIKEY! },
        body: JSON.stringify({ number: to, text }),
      },
    );

    const body = await res.text();
    if (!res.ok) return { ok: false, error: `${res.status} ${body.slice(0, 200)}` };

    /**
     * A 200 from Evolution means WhatsApp accepted it. The id it returns
     * is the one that will come back on the MESSAGES_UPSERT echo, so
     * storing it is what stops us reading our own outbound message as an
     * inbound one later.
     */
    try {
      const j = JSON.parse(body) as { key?: { id?: string } };
      return { ok: true, externalId: j.key?.id };
    } catch {
      return { ok: true };
    }
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const cause = e.cause?.code ?? e.cause?.message;
    const base = (() => {
      try {
        return env.EVOLUTION_URL ? new URL(env.EVOLUTION_URL).origin : 'unknown Evolution URL';
      } catch {
        return 'invalid Evolution URL';
      }
    })();
    return {
      ok: false,
      error: cause ? `${e.message} (${cause}) while calling ${base}` : `${e.message} while calling ${base}`,
    };
  }
}
