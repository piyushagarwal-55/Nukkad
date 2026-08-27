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

      /**
       * The conversation is the thing messages hang off, and it is also
       * where Meta's 24 hour session window is tracked. Past that window a
       * business may only send a PRE-APPROVED TEMPLATE, so the nudge
       * scheduler has to know when it closes -- and it can only know that
       * if something records when the customer last spoke.
       */
      const conversation = await prisma.conversation.upsert({
        where: { channel_peerPhone: { channel: 'twilio', peerPhone: inbound.senderId } },
        create: {
          channel: 'twilio',
          peerPhone: inbound.senderId,
          partyRole: 'HOUSEHOLD',
          lastInboundAt: new Date(),
          windowExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        update: {
          lastInboundAt: new Date(),
          windowExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      /**
       * IDEMPOTENCY, and it has to be a WRITE rather than a read.
       *
       * This used to check the Message table for the incoming SID and skip
       * if it found one -- but nothing ever wrote to that table, so the
       * guard read an empty table forever and did nothing at all. Twilio
       * retries any webhook it is not acknowledged fast enough, and a
       * retried voice note would be transcribed and ordered a second time.
       *
       * Inserting first and letting the unique index reject the duplicate
       * closes that, and closes the race a read-then-write cannot: two
       * retries arriving together both read nothing and both proceed.
       */
      try {
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            direction: 'IN',
            externalId: inbound.externalId,
            body: inbound.text ?? null,
            mediaPath: inbound.media[0]?.localPath ?? null,
            mediaMime: inbound.media[0]?.mime ?? null,
          },
        });
      } catch (err) {
        // P2002 is the unique violation on (conversationId, externalId):
        // this exact message has already been handled.
        if ((err as { code?: string }).code === 'P2002') {
          app.log.info({ sid: inbound.externalId }, 'duplicate inbound, ignoring');
          return;
        }
        throw err;
      }

      app.log.info(
        { from: maskPhone(inbound.senderId), media: inbound.media.length },
        'inbound whatsapp',
      );

      const replies = await handle(inbound);

      for (const r of replies) {
        await twilioAdapter.send(inbound.senderId, r);
        // recorded so the thread can be read back, and so a template sent
        // outside the window is auditable after the fact
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            direction: 'OUT',
            body: r.text ?? null,
            templateName: r.templateName ?? null,
          },
        });
      }
    } catch (err) {
      app.log.error({ err }, 'whatsapp handler failed');
    }
  });
}
