import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { handle } from '../services/conversation/core.js';
import { env } from '../config/env.js';

/**
 * WHATSAPP THROUGH EVOLUTION API -- the development transport.
 *
 * Twilio's sandbox allows 50 messages a day, which a single test
 * conversation can spend before lunch. Evolution pairs a REAL WhatsApp
 * account over the unofficial Web protocol (whatsmeow/Baileys family):
 * unlimited messages, no join codes, actual WhatsApp UX in a demo.
 *
 * THE HONEST TRADE, stated where the code lives: this is against
 * WhatsApp's terms and Meta does ban numbers that use it. It is paired
 * with a SPARE number, never a personal one, and it is a development
 * harness -- the production story remains an official API (Meta Cloud /
 * Twilio), which is why this file is one thin adapter over the same
 * handle() every other transport uses. Swapping transports later means
 * replacing this file, nothing else.
 *
 * SETUP (once):
 *   docker run -d --name evolution -p 8080:8080 \
 *     -e AUTHENTICATION_API_KEY=<pick-a-key> atendai/evolution-api:v2.1.1
 *   POST {EVOLUTION_URL}/instance/create {"instanceName":"nukkad","qrcode":true}
 *   scan the QR with the spare phone's WhatsApp
 *   POST {EVOLUTION_URL}/webhook/set/nukkad
 *     {"webhook":{"enabled":true,"url":"<this-server>/evolution/webhook",
 *      "events":["MESSAGES_UPSERT"]}}
 */
export async function evolutionRoutes(app: FastifyInstance) {
  const configured = () => !!env.EVOLUTION_URL && !!env.EVOLUTION_APIKEY;

  /** send one text back through the paired account */
  async function send(to: string, text: string): Promise<void> {
    const res = await fetch(
      `${env.EVOLUTION_URL}/message/sendText/${env.EVOLUTION_INSTANCE}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: env.EVOLUTION_APIKEY!,
        },
        body: JSON.stringify({ number: to, text }),
      },
    );
    if (!res.ok) {
      app.log.warn({ to, status: res.status, body: await res.text() }, 'evolution send failed');
    }
  }

  app.post('/evolution/webhook', async (req, reply) => {
    if (!configured()) return reply.code(503).send({ error: 'evolution not configured' });

    /**
     * Evolution wraps events as { event, instance, data }. A message is
     * MESSAGES_UPSERT with data.key.remoteJid (the peer),
     * data.key.fromMe, and the text living in one of two places
     * depending on message kind. Parsed defensively and LOGGED when the
     * shape surprises us, because the payload format is the one thing
     * here we cannot pin from our side.
     */
    const body = req.body as {
      event?: string;
      data?: {
        key?: { remoteJid?: string; fromMe?: boolean; id?: string };
        message?: {
          conversation?: string;
          extendedTextMessage?: { text?: string };
        };
        pushName?: string;
      };
    };

    const event = (body.event ?? '').toLowerCase().replace(/_/g, '.');
    if (event !== 'messages.upsert') return { ok: true };

    const d = body.data;
    // our own outbound messages echo back through the same event
    if (!d?.key?.remoteJid || d.key.fromMe) return { ok: true };
    // groups and broadcast lists are not customers
    if (!d.key.remoteJid.endsWith('@s.whatsapp.net')) return { ok: true };

    const text = d.message?.conversation ?? d.message?.extendedTextMessage?.text ?? '';
    if (!text.trim()) {
      app.log.info({ keys: Object.keys(d.message ?? {}) }, 'evolution: no text in message');
      return { ok: true };
    }

    const phone = `+${d.key.remoteJid.split('@')[0]}`;

    /**
     * Answered AFTER acking the webhook, not inside it. Evolution
     * retries slow webhooks, and a retried webhook is a customer
     * answered twice. The externalId carries WhatsApp's own message id,
     * so even a delivered retry would be traceable.
     */
    setImmediate(async () => {
      try {
        const replies = await handle({
          channel: 'evolution',
          senderId: phone,
          recipientId: env.EVOLUTION_SHOP_PHONE || phone,
          text,
          media: [],
          externalId: `evo_${d.key?.id ?? randomUUID()}`,
          receivedAt: new Date(),
        });
        for (const r of replies) await send(phone, r.text);
      } catch (err) {
        app.log.error({ err, phone }, 'evolution turn failed');
      }
    });

    return { ok: true };
  });
}
