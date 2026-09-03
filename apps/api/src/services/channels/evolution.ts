import { env } from '../../config/env.js';

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
  Boolean(env.EVOLUTION_URL && env.EVOLUTION_APIKEY);

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
    return { ok: false, error: (err as Error).message };
  }
}
