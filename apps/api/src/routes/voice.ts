import type { FastifyInstance } from 'fastify';
import { prisma, Prisma } from '@nukkad/db';
import { voiceTurn } from '../services/voice/turn.js';

/**
 * The browser end of the voice agent.
 *
 * Deliberately the same voiceTurn() the local harness uses and the same
 * one a phone webhook will use. A call is a transport; this is a
 * transport; neither is the agent. The point of that is cost -- every
 * fix can be found and verified here for nothing, and telephony credit
 * is spent only on confirming that the transport works.
 *
 * The whole trace comes back in the response rather than only being
 * logged, so the page can show what the ear heard next to what the shop
 * said. Nearly every voice bug is visible in that one comparison, and it
 * is exactly the line you cannot see from a handset.
 */
export async function voiceRoutes(app: FastifyInstance) {
  const HOUSEHOLD = '+918979560165';
  const SHOP = '+919927306131';

  /**
   * Raw audio bytes, not multipart. The browser posts a Blob straight
   * from MediaRecorder and this saves a parser and a dependency; the
   * content type carries the codec, and ffmpeg normalises it anyway.
   */
  app.addContentTypeParser(
    ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  app.post('/voice/turn', async (req, reply) => {
    const audio = req.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length < 1024) {
      return reply.code(400).send({ error: 'no audio' });
    }

    const mime = (req.headers['content-type'] ?? 'audio/webm').split(';')[0];

    const { trace, audio: out } = await voiceTurn(audio, {
      phone: HOUSEHOLD,
      shopPhone: SHOP,
      mime,
    });

    /**
     * Logged server-side as well as returned, in one block, because the
     * fastest way to fix a voice bug is to paste the whole turn to
     * somebody rather than describe it.
     */
    app.log.info(
      {
        heard: trace.heard,
        engine: trace.asrEngine,
        action: `${trace.action}/${trace.goal}`,
        said: trace.spoken,
        basket: trace.basket,
        ms: { ear: trace.asrMs, mouth: trace.ttsMs, total: trace.totalMs },
      },
      'voice turn',
    );

    return {
      ...trace,
      // base64 so the page can play it without a second request
      audioBase64: out ? out.toString('base64') : null,
    };
  });

  /** start a fresh conversation, so a test run is not read against a stale basket */
  app.post('/voice/reset', async () => {
    await prisma.conversation.updateMany({
      where: { channel: 'sim', peerPhone: HOUSEHOLD },
      data: { state: 'IDLE', contextJson: Prisma.DbNull },
    });
    return { ok: true };
  });
}
