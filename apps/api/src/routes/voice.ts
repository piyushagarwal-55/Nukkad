import type { FastifyInstance } from 'fastify';
import { prisma, Prisma } from '@nukkad/db';
import { voiceTurn } from '../services/voice/turn.js';
import { speak } from '../services/voice/tts.js';

/**
 * The browser end of the voice agent.
 *
 * Deliberately the same voiceTurn() the local harness uses and the same
 * one a phone webhook will use. A call is a transport; this is a
 * transport; neither is the agent. That is what makes every fix findable
 * for free -- telephony credit gets spent confirming the transport, not
 * debugging the shop.
 *
 * The reply is streamed as SERVER-SENT EVENTS rather than returned whole,
 * because the point of chunking speech is that playback starts before
 * synthesis finishes. Waiting for the last sentence to be made before
 * sending the first defeats it entirely.
 *
 * Wire format, one JSON object per event:
 *
 *   {"type":"trace", ...}                 what was heard and decided
 *   {"type":"audio","index":0,"b64":...}  a sentence, ready to play
 *   {"type":"done","firstMs":..,"totalMs":..}
 */
export async function voiceRoutes(app: FastifyInstance) {
  const HOUSEHOLD = '+918979560165';
  const SHOP = '+919927306131';

  /**
   * BARGE-IN. One turn per caller, and a new one cancels the old.
   *
   * If the customer starts talking while the shop is still speaking, the
   * sentences not yet synthesised are never made -- which is both faster
   * and the difference between an agent that listens and one that talks
   * over you. Keyed by phone because that is who is interrupting whom.
   */
  const inFlight = new Map<string, AbortController>();

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

    inFlight.get(HOUSEHOLD)?.abort();
    const ctrl = new AbortController();
    inFlight.set(HOUSEHOLD, ctrl);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Credentials': 'true',
    });

    const send = (o: unknown) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(o)}\n\n`);
    };

    try {
      const mime = (req.headers['content-type'] ?? 'audio/webm').split(';')[0];

      /**
       * SYNTHESIS STARTS BEFORE THE REPLY IS WRITTEN.
       *
       * Each sentence arrives here the moment the model finishes it, and
       * its audio is made and sent while the next one is still being
       * composed. Nothing waits for the whole reply: not the speech, not
       * the page. The chain keeps them in order -- sentence two must not
       * overtake sentence one just because it was shorter to say.
       */
      const started = Date.now();
      let firstSoundMs = 0;
      let index = 0;
      let chain: Promise<void> = Promise.resolve();

      const { trace } = await voiceTurn(audio, {
        phone: HOUSEHOLD,
        shopPhone: SHOP,
        mime,
        speak: false,
        onSentence: (sentence) => {
          chain = chain.then(async () => {
            if (ctrl.signal.aborted) return;
            const said = await speak(sentence);
            if (!said || ctrl.signal.aborted) return;
            if (!firstSoundMs) firstSoundMs = Date.now() - started;
            send({
              type: 'audio',
              index: index++,
              text: sentence,
              b64: said.audio.toString('base64'),
              ms: said.latencyMs,
            });
          });
        },
      });

      await chain;
      if (ctrl.signal.aborted) return reply.raw.end();

      /**
       * The trace goes out AFTER the audio, which looks backwards and is
       * not: the caller wants sound as early as possible, and the trace
       * cannot be complete until the reply is. The page shows the words
       * from the sentences as they arrive.
       */
      send({ type: 'trace', ...trace });
      const spoken = { chunks: index, firstMs: firstSoundMs, totalMs: Date.now() - started };
      send({ type: 'done', ...spoken });

      app.log.info(
        {
          heard: trace.heard,
          engine: trace.asrEngine,
          action: `${trace.action}/${trace.goal}`,
          said: trace.spoken,
          basket: trace.basket,
          ms: { ear: trace.asrMs, think: trace.totalMs - trace.asrMs, firstSound: spoken.firstMs },
        },
        'voice turn',
      );
    } catch (err) {
      app.log.error({ err }, 'voice turn failed');
      send({ type: 'error', message: (err as Error).message });
    } finally {
      if (inFlight.get(HOUSEHOLD) === ctrl) inFlight.delete(HOUSEHOLD);
      reply.raw.end();
    }
  });

  /** start a fresh conversation, so a test run is not read against a stale basket */
  app.post('/voice/reset', async () => {
    inFlight.get(HOUSEHOLD)?.abort();
    await prisma.conversation.updateMany({
      where: { channel: 'sim', peerPhone: HOUSEHOLD },
      data: { state: 'IDLE', contextJson: Prisma.DbNull },
    });
    return { ok: true };
  });
}
