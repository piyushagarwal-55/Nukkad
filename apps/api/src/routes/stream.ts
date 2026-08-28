import type { FastifyInstance } from 'fastify';
import { openEar } from '../services/asr/realtime.js';
import { handle } from '../services/conversation/core.js';
import { openMouth } from '../services/voice/mouth.js';
import { voiceFor } from '../services/voice/voices.js';
import type { Desk } from '../services/policy/desks.js';
import { warm } from '../services/conversation/routing.js';
import { resetConvo, deskTo } from '../services/conversation/state.js';
import { randomUUID } from 'node:crypto';
import type { SpeechAct } from '../services/policy/intent.js';

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
     * SOMEBODY PICKS THE PHONE UP. A new call starts at reception even
     * when the last one ended at the counter -- the desk persisted with
     * the conversation, which is right for a WhatsApp thread and wrong
     * for a phone line. This was found from a live trace: "Hello" was
     * answered with the SELLER's greeting because the previous session
     * had left the desk there, and the entire reception layer silently
     * never ran. Basket and referents are kept; only the person answering
     * changes.
     */
    void deskTo('sim', HOUSEHOLD, 'RECEPTION');

    /** which desks spoke this turn, in order -- the trace's ownership proof */
    let turnDesks: Desk[] = [];

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
    /**
     * WHAT THE SHOP SAID TO FILL THE LAST SILENCE, remembered for the
     * length of the call.
     *
     * Without this the filler was on every single reply -- "haan ji" as
     * reliably as a dial tone, which is the exact tic the Response
     * Director exists to prevent, rebuilt two layers down. A filler is
     * only ever worth saying when it is unexpected; the moment a customer
     * can predict it, it has stopped covering a silence and started being
     * a verbal habit they hear instead of the words.
     */
    let lastFiller: string | null = null;
    let filledLastTurn = false;

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
      turnDesks = [];
      let firstSoundMs = 0;

      /**
       * A MOUTH PER TURN, fed as the composer writes.
       *
       * The batch synthesiser this replaces took a finished sentence and
       * returned a finished WAV, so speech was the last stage of a
       * pipeline that could not start until every stage before it had
       * ended. Measured on a real call: "haan ji" at 1316ms, then seven
       * seconds of silence, then the answer. The filler made that worse
       * rather than better -- it proved the line was open and then left a
       * gap that sounded like a fault.
       *
       * Per turn rather than per session, because there is no way to
       * cancel synthesis already in flight on a shared socket: a
       * barge-in would cut off audio the previous sentence was still
       * producing. Closing this one and opening the next costs a
       * handshake the composer is going to outlast anyway.
       */
      /**
       * The trace is not sent until sound has actually started.
       *
       * handle() returning does not mean the customer has heard anything
       * -- the synthesiser is still working when the last sentence is
       * handed to it -- so reporting the turn the moment the text was
       * ready printed `first sound 0ms` on turns that took well over a
       * second to speak. The number was measuring the wrong end.
       */
      let heard!: () => void;
      const sounded = new Promise<void>((r) => { heard = r; });

      const mouth = openMouth({
        onAudio: (b64) => {
          if (ctrl.signal.aborted) return;
          if (!firstSoundMs) {
            firstSoundMs = Date.now() - started;
            heard();
          }
          send({ type: 'audio', b64 });
        },
        onError: (message) => app.log.warn({ message }, 'tts stream'),
      });

      /**
       * SENTENCES REMAIN THE UNIT, and this is a safety property rather
       * than a convenience. composeStream checks every sentence against
       * the digits it was actually given before releasing it -- see
       * violates() in conversation/compose.ts, which exists because the
       * model once drew its own imitation ledger above the real one.
       * Streaming raw tokens into the mouth would speak a fabricated
       * total before anything had a chance to check it, and a number
       * said out loud cannot be taken back.
       *
       * The win is not finer granularity. It is that a validated
       * sentence now goes into an open socket and comes back as audio in
       * ~220ms, instead of waiting for the whole reply and then paying
       * 1711ms for a batch render of all of it.
       */
      let spokenYet = false;
      let act: SpeechAct | null = null;
      let filled = false;

      /**
       * THE FILLER IS FOR SILENCES, AND MOST TURNS NO LONGER HAVE ONE.
       *
       * At 700ms it fired on effectively every reply, because the fast
       * path in realize.ts still needs route plus policy -- about 1.0 to
       * 1.5 seconds -- before it has a sentence. So the threshold was
       * below the normal case rather than above it, and a filler that
       * happens every time is not covering anything. It is a tic.
       *
       * 1200ms sits above the fast path and below the composed one, so
       * an ordinary add or price answer is simply silent for a moment
       * and then speaks, while a turn that has to write prose gets
       * something to sit on.
       */
      const timer = setTimeout(() => {
        if (spokenYet || ctrl.signal.aborted) return;

        /**
         * Two silences in a row get one filler, not two. Whatever the
         * second one would have said, the customer has just heard, and
         * hearing it again is worse than the pause it was covering.
         */
        if (filledLastTurn) return;

        const line = fillerFor(act, lastFiller);
        if (!line) return;

        filled = true;
        lastFiller = line;
        spokenYet = true;
        mouth.say(line);
        mouth.flush();
      }, 1200);

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
            /**
             * The desk's voice, switched on the open socket. At turn
             * start this edits the config before the handshake; on a
             * transfer it is one frame, and Sarvam flushes the old
             * desk's goodbye in the old voice before applying it. No
             * reconnect, no gap -- see setSpeaker in voice/mouth.ts.
             */
            onDesk: (desk: Desk) => {
              turnDesks.push(desk);
              mouth.setSpeaker(voiceFor(desk));
              send({ type: 'desk', desk });
            },
            onDecision: (chosen: SpeechAct) => {
              act = chosen;
            },
            onSentence: (sentence) => {
              clearTimeout(timer);
              /**
               * NOTHING IS PREPENDED HERE, and the version that did is
               * why every reply began with "haan ji".
               *
               * The idea was sound -- a filler merged into the front of
               * the answer is one utterance instead of a greeting, a
               * pause and an answer. The implementation was not: it
               * prepended whenever the filler had not already been
               * spoken, which on a fast turn is always. So the merge
               * that existed to remove a gap put a greeting on replies
               * that never had one.
               */
              spokenYet = true;
              mouth.say(`${sentence} `);
              mouth.flush();
            },
          },
        );

        if (ctrl.signal.aborted) return;

        /**
         * Bounded, because a synthesiser that never answers must not hold
         * the trace hostage -- the words are still worth showing even
         * when the voice failed.
         */
        await Promise.race([sounded, new Promise((r) => setTimeout(r, 4000))]);
        if (ctrl.signal.aborted) return;

        const reply = replies.map((r) => r.text).join('\n');
        /**
         * OWNERSHIP IS IN THE TRACE. Which desk answered, and whether
         * this turn crossed one -- the thing a reply's intent/goal label
         * cannot show, and the reason a working transfer looked like a
         * generic QA path from the outside.
         */
        send({
          type: 'turn',
          heard: text,
          reply,
          action: replies[0]?.intent ?? 'UNKNOWN',
          goal: replies[0]?.goal ?? 'UNKNOWN',
          desk: turnDesks[turnDesks.length - 1] ?? null,
          from: turnDesks.length > 1 ? turnDesks[0] : null,
          handoff: turnDesks.length > 1,
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
        // so the next silence knows this one was already covered
        filledLastTurn = filled;
        /**
         * Held open briefly after the last sentence, because the final
         * chunks of an utterance arrive after the text that produced
         * them. Closing on the last flush would clip the last word.
         */
        setTimeout(() => mouth.close(), 4000);
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
    await resetConvo('sim', HOUSEHOLD);
    return { ok: true };
  });
}

/**
 * WHAT THE SHOP SAYS WHILE IT IS STILL WORKING IT OUT.
 *
 * Variants per action, because one string per branch is a template and
 * this codebase deleted its templates for a reason. A shopkeeper
 * reaching for a bag and one checking a price make different noises, and
 * neither makes the same noise twice running.
 *
 * The empty entries are deliberate. CLARIFY and NOT_UNDERSTOOD are about
 * to admit the shop did not follow, and sounding busy first makes that
 * worse; GREET and the confirmations are fast enough that the timer
 * never reaches them. An action with no entry gets silence, and silence
 * is a valid thing to say.
 */
const REACTIONS: Partial<Record<SpeechAct, string[]>> = {
  BUY: ['Haan, rakhta hoon...', 'Ji, likh raha hoon...'],
  MODIFY: ['Haan, hata raha hoon...', 'Ji, nikaal deta hoon...'],
  ASK: ['Ek second, dekhta hoon...', 'Haan, dekh raha hoon...'],
  ASK_RECOMMENDATION: ['Hmm, sochne dijiye...', 'Achha, ek second...'],
  REPEAT_ORDER: ['Haan, pichhla order nikaal raha hoon...'],
  ACCOUNT: ['Ek second, hisaab dekh raha hoon...'],
  CHECKOUT: ['Haan ji, total nikaal raha hoon...', 'Theek hai, jod raha hoon...'],
  PAYMENT_CLAIM: ['Ek second, check karta hoon...'],
  ORDER_STATUS: ['Ek second, aapka order dekh raha hoon...'],
  ASK_OFFER: ['Ek second, offers confirm karta hoon...'],
};

/** said when the policy has not answered yet, which is most of the time */
const NEUTRAL = ['Haan ji...', 'Ji...', 'Achha...', 'Ek second...'];

/**
 * A line the shop has not just used.
 *
 * `avoid` is whatever filled the previous silence, so the same noise
 * cannot land twice in a row even across different actions. When the
 * only candidate is the one just used, this returns null and the shop
 * simply waits -- a repeated filler is worse than the pause it covers.
 */
function fillerFor(act: SpeechAct | null, avoid: string | null): string | null {
  const options = (act && REACTIONS[act]) ?? NEUTRAL;
  const fresh = options.filter((o) => o !== avoid);
  if (!fresh.length) return null;
  return fresh[Math.floor(Date.now() / 1000) % fresh.length]!;
}
