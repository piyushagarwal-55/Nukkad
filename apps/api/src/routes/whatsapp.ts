import type { FastifyInstance } from 'fastify';
import { prisma } from '@nukkad/db';
import { twilioAdapter } from '../channels/index.js';
import { handle } from '../services/conversation/core.js';
import { maskPhone } from '../lib/phone.js';

/**
 * Twilio posts application/x-www-form-urlencoded here.
 *
 * Point this at your ngrok domain in:
 *   Twilio Console > Messaging > Try it out > Send a WhatsApp message
 *   > Sandbox settings > "When a message comes in"
 *
 * Right now that field still points at Twilio's own demo echo bot, so
 * nothing will reach this handler until it is changed.
 */
export async function whatsappRoutes(app: FastifyInstance) {
  app.post('/wa/twilio', async (req, reply) => {
    // Answer Twilio immediately. Whisper plus the LLM takes a couple of
    // seconds and Twilio will retry a slow webhook, which would double
    // every order.
    reply.header('content-type', 'text/xml').send('<Response></Response>');

    const body = req.body as Record<string, string>;

    try {
      const inbound = await twilioAdapter.parse(body);

      // Idempotency. Twilio retries, and a retried voice note would
      // otherwise be transcribed and ordered twice.
      const seen = await prisma.message.findFirst({
        where: { externalId: inbound.externalId },
      });
      if (seen) {
        app.log.info({ sid: inbound.externalId }, 'duplicate inbound, ignoring');
        return;
      }

      app.log.info(
        { from: maskPhone(inbound.senderId), media: inbound.media.length },
        'inbound whatsapp',
      );

      const replies = await handle(inbound);
      for (const r of replies) await twilioAdapter.send(inbound.senderId, r);
    } catch (err) {
      app.log.error({ err }, 'whatsapp handler failed');
    }
  });
}
