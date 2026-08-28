import type { FastifyInstance } from 'fastify';
import { openEar } from '../services/asr/realtime.js';
import { handle } from '../services/conversation/core.js';
import { speak } from '../services/voice/tts.js';
import { warm } from '../services/conversation/routing.js';
import { prisma } from '@nukkad/db';
import { randomUUID } from 'node:crypto';
import type { PolicyAction } from '../services/policy/decide.js';

/**
 * THE VOICE SESSION, held open for as long as the page is.
 *
 * What this replaces: hold a button, record a blob, upload it, wait for
 * the whole clip to be decoded and transcribed, then start thinking. Four
 * stages in series, each waiting for the last, and the first turn of a
 * session paying a TLS handshake and a cold model on top -- 4603ms in
 * `ear` alone against 537ms on the second turn of the same call.
 *
 * Now: one socket to the browser, one socket to Sarvam, both opened when
 * the page loads. Audio flows up as it is spoken and the transcript comes
 * back as it is recognised, so the moment the customer stops talking the
 * words are already here. Sarvam's own VAD decides when they stopped,
 * which also means nobody has to hold a button down.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE, and everything else is
 * plumbing: a partial transcript may PREPARE and may never COMMIT.
 *
 * "do kilo aashirvaad" is a prefix of "do kilo aashirvaad atta daal do".
 * It is equally a prefix of "do kilo aashirvaad atta nahi chahiye" and of
 * "do kilo aashirvaad atta kal bhejna". A system that put a bag in a
 * basket on the first would have to take it out on the second and
 * reschedule it on the third, and the customer would watch it happen.
 * Speculation is therefore restricted to work that is READ-ONLY and
 * IDEMPOTENT -- opening connections, filling caches -- and the entire
 * agent runs on `transcript.final` exactly as it did before.
 *
 * That restriction is what keeps this a latency change rather than a
 * correctness risk. handle() is untouched, so every guard it has -- the
 * consent check on checkout, the closed action enum with no token for
 * marking a payment received -- applies identically here.
 */
export async function streamRoutes(app: FastifyInstance) {
  const HOUSEHOLD = '+918979560165';
  const SHOP = '+919927306131';

  app.get('/voice/stream', { websocket: true }, (socket) => {
    const send = (o: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(o));
    };

    /**
     * One turn at a time, and a new utterance cancels the last. If the
     * customer starts talking while the shop is still speaking, the
     * sentences not yet synthesised are never made -- which is both
     * faster and the difference between an agent that listens and one
     * that talks over you.
     */
    let inFlight: AbortController | null = null;
    let busy = false;

    /**
     * Fired on the first partial of a session rather than on connect, so
     * the cost lands while somebody is drawing breath rather than while
     * the page is still rendering. Idempotent and cached, so calling it
     * on every partial would be harmless -- once is simply enough.
     */
    let prepared = false;
    const prepare = () => {
      if (prepared) return;
      prepared = true;
      void warm(HOUSEHOLD, SHOP);
    };

    const ear = openEar({
      onSpeechStart: () => {
        // barge-in: they have started talking, so stop talking back
        inFlight?.abort();
        send({ type: 'listening' });
      },

      onPartial: (text) => {
        prepare();
        /**
         * Sent to the page for the same reason the trace is on screen at
         * all: seeing the words arrive is how you tell a slow agent from
         * a deaf one, and it is the single most useful thing a caller can
         * be shown while they wait.
         */
        send({ type: 'partial', text });
      },

      onSpeechEnd: () => send({ type: 'thinking' }),

      onFinal: (text) => {
        if (busy) return;
        busy = true;

        const ctrl = new AbortController();
        inFlight?.abort();
        inFlight = ctrl;

        void runTurn(text, ctrl).finally(() => {
          busy = false;
          if (inFlight === ctrl) inFlight = null;
        });
      },

      onError: (message, fatal) => send({ type: 'error', message, fatal }),
      onClose: () => send({ type: 'ear-closed' }),
    });

    /**
     * The turn itself, which is the ordinary agent with a microphone in
     * front of it. Note what is NOT here: no policy, no resolver, no
     * composer. handle() owns all of that and is shared with WhatsApp, so
     * a fix made for one is a fix made for both and the two cannot drift.
     */
    async function runTurn(text: string, ctrl: AbortController) {
      const started = Date.now();
      let firstSoundMs = 0;
      let index = 0;
      let chain: Promise<void> = Promise.resolve();

      /**
       * The same 700ms race the button path uses, for the same reason:
       * nothing can be said until the policy, the resolver and the
       * composer are all done, and silence on a phone reads as a dropped
       * line. The clock starts here rather than when the action is known,
       * because the policy call is the slow part -- arming it afterwards
       * meant it never once fired.
       */
      let spokenYet = false;
      const say = (sentence: string) => {
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
          });
        });
      };

      let reaction: string | null = 'Haan ji...';
      const timer = setTimeout(() => {
        if (spokenYet || !reaction || ctrl.signal.aborted) return;
        spokenYet = true;
        say(reaction);
      }, 700);

      try {
        const replies = await handle(
          {
            channel: 'sim',
            senderId: HOUSEHOLD,
            recipientId: SHOP,
            text,
            media: [],
            externalId: `stream_${randomUUID()}`,
            receivedAt: new Date(),
          },
          {
            onDecision: (action: PolicyAction) => {
              reaction = REACTIONS[action] ?? null;
            },
            onSentence: (sentence) => {
              spokenYet = true;
              clearTimeout(timer);
              say(sentence);
            },
          },
        );

        await chain;
        if (ctrl.signal.aborted) return;

        const reply = replies.map((r) => r.text).join('\n');
        send({
          type: 'turn',
          heard: text,
          reply,
          action: replies[0]?.intent ?? 'UNKNOWN',
          goal: replies[0]?.goal ?? 'UNKNOWN',
          firstSoundMs,
          totalMs: Date.now() - started,
        });

        app.log.info(
          { heard: text, said: reply, firstSound: firstSoundMs, total: Date.now() - started },
          'stream turn',
        );
      } catch (err) {
        app.log.error({ err }, 'stream turn failed');
        send({ type: 'error', message: (err as Error).message, fatal: false });
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * Audio arrives as raw binary rather than base64 in JSON, because the
     * browser is sending ~100ms of PCM every ~100ms and base64 over a
     * local socket is a third more bytes for nothing. It is re-encoded
     * once, on the way to Sarvam, whose protocol does want it in JSON.
     */
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        ear.send(data);
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === 'stop') inFlight?.abort();
      } catch {
        // a malformed control frame is not worth closing a call over
      }
    });

    socket.on('close', () => {
      inFlight?.abort();
      ear.close();
    });
  });

  /** the same fresh start the button page has */
  app.post('/voice/stream/reset', async () => {
    await prisma.conversation.updateMany({
      where: { channel: 'sim', peerPhone: HOUSEHOLD },
      data: { state: 'IDLE', contextJson: null as never },
    });
    return { ok: true };
  });
}

/**
 * What the shop says while it is still working it out, keyed on what it
 * has decided to do. A single filler becomes a tic by the third turn;
 * CLARIFY and NOT_UNDERSTOOD get silence, because a turn about to admit
 * it does not know should not sound busy first.
 */
const REACTIONS: Partial<Record<PolicyAction, string>> = {
  ADD_EXPLICIT_PRODUCT: 'Haan, rakhta hoon...',
  ADD_FROM_STATE: 'Haan ji, karta hoon...',
  REMOVE_EXPLICIT_PRODUCT: 'Haan, hata raha hoon...',
  REMOVE_FROM_STATE: 'Ji, hata deta hoon...',
  ANSWER_PRICE: 'Ek second, dekhta hoon...',
  ANSWER_STOCK: 'Ruko, dekhta hoon...',
  SEARCH_PRODUCT: 'Ek minute, dekhta hoon...',
  RECOMMEND: 'Hmm, sochne dijiye...',
  REPEAT_LAST_ORDER: 'Haan, pichhla order nikaal raha hoon...',
  ACCOUNT_SUMMARY: 'Ek second, hisaab dekh raha hoon...',
  CHECKOUT: 'Haan ji, total nikaal raha hoon...',
  PAYMENT_STATUS_QUERY: 'Ek second, check karta hoon...',
};
