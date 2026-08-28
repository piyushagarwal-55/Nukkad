import 'dotenv/config';
import { openMouth } from '../services/voice/mouth.js';
import { speak } from '../services/voice/tts.js';

/**
 * DOES THE STREAMING MOUTH ACTUALLY WORK, AND IS IT ACTUALLY FASTER.
 *
 *   npm run mouth --workspace=@nukkad/api
 *
 * Written before a single line of the voice path was rewired, for the
 * same reason scripts/ear.ts was: a WebSocket protocol is a pile of
 * assumptions -- subprotocol auth, config-before-text, event names, codec
 * strings -- and discovering which one is wrong through a microphone and
 * a React page is a bad way to spend an afternoon.
 *
 * It answers three questions in order of how likely each was to be wrong:
 *
 *   1. does the handshake succeed, and does config-then-text produce audio
 *   2. how long until the FIRST chunk, which is what a caller waits for
 *   3. is that meaningfully sooner than the batch endpoint we have
 *
 * Question three is the one that decides whether any of this was worth
 * doing. The batch call is measured right beside it on the same sentence,
 * because "streaming is faster" is a claim and the difference between the
 * two numbers is a measurement.
 *
 * FED IN CLAUSES, the way a composer emits them, rather than all at once.
 * Sending the whole sentence in one message would measure the server's
 * synthesis speed and tell us nothing about whether audio starts before
 * the text has finished arriving, which is the entire point.
 */

const SENTENCE = [
  'Haan ji, ',
  'Aashirvaad Whole Wheat Atta ',
  'paanch kilo ka packet ',
  'rakh diya hai. ',
  'Aur kuch chahiye?',
];

const at = Date.now();
const since = () => String(Date.now() - at).padStart(5);

let chunks = 0;
let bytes = 0;
let firstChunkMs = 0;
let firstFlushMs = 0;

await new Promise<void>((done) => {
  const mouth = openMouth({
    onAudio: (b64, contentType) => {
      chunks++;
      const size = Buffer.from(b64, 'base64').length;
      bytes += size;
      if (!firstChunkMs) {
        firstChunkMs = Date.now() - at;
        console.log(`${since()}ms  FIRST AUDIO  ${size} bytes  ${contentType}`);
      } else {
        console.log(`${since()}ms  audio        ${size} bytes`);
      }
    },
    onDone: () => {
      console.log(`${since()}ms  final event`);
      mouth.close();
      done();
    },
    onError: (message) => {
      console.error(`${since()}ms  ERROR  ${message}`);
      mouth.close();
      done();
    },
  });

  /**
   * Clauses arrive 120ms apart, which is roughly the pace a streamed
   * completion produces them at. If the first audio comes back before
   * the last clause is sent, the pipeline genuinely overlaps.
   */
  void (async () => {
    for (const clause of SENTENCE) {
      mouth.say(clause);
      console.log(`${since()}ms  sent text    "${clause.trim()}"`);

      /**
       * FLUSHED AT SENTENCE ENDS, and the first run is why.
       *
       * With min_buffer_size alone the server held every clause and the
       * first audio arrived 14ms AFTER the final flush -- so the whole
       * utterance was synthesised at the end, exactly like the batch
       * call it was supposed to beat. Whatever min_buffer_size counts,
       * it did not start synthesis here.
       *
       * A flush on a full stop is not the sub-clause chunking that
       * causes audible seams. A sentence is a complete prosodic unit;
       * the synthesiser needs nothing after the full stop to say what
       * came before it.
       */
      if (/[.!?]\s*$/.test(clause)) {
        if (!firstFlushMs) firstFlushMs = Date.now() - at;
        mouth.flush();
        console.log(`${since()}ms  flush        (sentence end)`);
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    mouth.flush();
    console.log(`${since()}ms  flush        (end of reply)`);
  })();

  // a stuck socket must not hang the script
  setTimeout(() => done(), 20_000);
});

/**
 * The same sentence through the endpoint this replaces. One number is a
 * claim; two are a comparison.
 */
const whole = SENTENCE.join('');
const batchAt = Date.now();
const said = await speak(whole);
const batchMs = Date.now() - batchAt;

/**
 * THE NUMBER THAT MATTERS IS FLUSH TO FIRST AUDIO.
 *
 * The first version of this report compared the first chunk against the
 * moment the last clause was sent, and called anything later a failure.
 * Wrong question: the whole design is that a SENTENCE is flushed as soon
 * as it is complete, and the clauses after it are still being written
 * while its audio plays. What the caller waits for is the gap between a
 * finished sentence and hearing it.
 *
 * Under the batch endpoint that gap was the entire synthesis of the
 * entire reply, because nothing could be flushed until everything had
 * been written.
 */
console.log(`
  streaming: first flush ${firstFlushMs}ms -> first audio ${firstChunkMs}ms`);
console.log(`             ${chunks} chunks, ${bytes} bytes`);
console.log(`  batch:     ${batchMs}ms for ${said ? said.audio.length : 0} bytes, none of it early`);
console.log(`
  A SENTENCE BECOMES SOUND IN ${firstChunkMs - firstFlushMs}ms, against ${batchMs}ms for the whole reply`);



/**
 * THE HANDOFF, AS AUDIO. Old voice, transfer line, one config frame,
 * new voice -- on the SAME socket.
 *
 * What this proves and what it cannot: it proves the protocol accepts a
 * speaker change mid-stream without reconnecting and that audio keeps
 * flowing after the switch, with the old-voice text flushed first. It
 * cannot prove the two voices SOUND different -- that needs ears, not
 * asserts. Byte-counts per phase are printed as circumstantial evidence:
 * two runs of the same text in genuinely different voices should differ.
 */
console.log(`\n${'='.repeat(64)}\nSPEAKER SWITCH, same socket`);


await new Promise<void>((done) => {
  const at2 = Date.now();
  let phase = 'OLD';
  const bytesBy: Record<string, number> = { OLD: 0, NEW: 0 };
  let chunksAfterSwitch = 0;

  const m = openMouth({
    onAudio: (b64) => {
      const n = Buffer.from(b64, 'base64').length;
      bytesBy[phase] = (bytesBy[phase] ?? 0) + n;
      if (phase === 'NEW') chunksAfterSwitch++;
      console.log(`${String(Date.now() - at2).padStart(5)}ms  audio [${phase}] ${n} bytes`);
    },
    onDone: () => {
      if (phase === 'OLD') return; // first utterance finished; wait for the second
      console.log(`\n  seller-voice bytes ${bytesBy.OLD}, checkout-voice bytes ${bytesBy.NEW}`);
      console.log(
        chunksAfterSwitch > 0
          ? '  AUDIO CONTINUED AFTER THE SWITCH on the same connection, which is the point'
          : '  no audio after the switch -- the config frame killed the stream',
      );
      m.close();
      done();
    },
    onError: (msg) => {
      console.error(`  ERROR ${msg}`);
      m.close();
      done();
    },
  }, { speaker: 'rahul' });

  m.say('Bilkul ji, billing counter pe bhej raha hoon. ');
  m.flush();

  // the switch goes in behind the flushed text, exactly as a transfer does
  setTimeout(() => {
    phase = 'NEW';
    m.setSpeaker('ritu');
    m.say('Haan ji, aapka order mere paas aa gaya hai. Total dekh leta hoon. ');
    m.flush();
  }, 1200);

  setTimeout(() => done(), 15_000);
});
process.exit(0);
