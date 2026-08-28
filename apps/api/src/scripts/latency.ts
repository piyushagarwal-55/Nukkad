import 'dotenv/config';
import { prisma, Prisma } from '@nukkad/db';
import { randomUUID } from 'node:crypto';
import { handle } from '../services/conversation/core.js';
import { profile, report, type Span } from '../services/telemetry/span.js';
import { speak } from '../services/voice/tts.js';
import type { InboundMessage } from '@nukkad/shared';

/**
 * WHERE THE TEN SECONDS GO.
 *
 *   npm run latency --workspace=@nukkad/api
 *
 * The browser trace could only say ear 762ms, think 6492ms, first sound
 * +10151ms -- and "think" is a word covering a policy call, a resolver, a
 * composer, and however many database round trips to a region 3,000km
 * away. This runs the real handle() under the span recorder and prints
 * what actually costs what.
 *
 * TEXT, NOT AUDIO, deliberately. ASR is a fixed ~750ms of somebody else's
 * network and there is nothing to optimise in it; every millisecond worth
 * arguing about is downstream of the transcript. TTS is measured
 * separately at the bottom because it is the other end of the same
 * question: what does the caller WAIT for before hearing anything.
 *
 * COLD AND WARM, because the caches make these two different systems. A
 * shopkeeper's first customer of the morning pays for the catalogue, the
 * stock map and the reorder prior; everyone after them does not. Both
 * numbers are real and only one of them is the demo.
 */

const HOUSEHOLD = '+918979560165';
const SHOP = '+919927306131';

const inbound = (text: string): InboundMessage => ({
  channel: 'sim',
  senderId: HOUSEHOLD,
  recipientId: SHOP,
  text,
  media: [],
  externalId: `lat_${randomUUID()}`,
  receivedAt: new Date(),
});

/** the turns a demo actually contains, in the order it contains them */
const SCRIPT = [
  'namaste',
  'do kilo atta bhej dena',
  'ek kilo chini bhi',
  'aate ka price kya hai',
  'bas itna hi',
];

async function reset() {
  await prisma.conversation.updateMany({
    where: { channel: 'sim', peerPhone: HOUSEHOLD },
    data: { state: 'IDLE', contextJson: Prisma.DbNull },
  });
}

/**
 * REPEATED, because one pass measures the weather.
 *
 * Groq and Sarvam are somebody else's queue. The same turn was 1920ms on
 * one run and 3603ms on the next with no code between them, which is the
 * lesson the ASR bench taught when a clip scored 0/3 and then 2/3
 * unchanged: a single number off a shared service is an anecdote, and
 * optimising against anecdotes is how you spend a day making something
 * slower and believing otherwise.
 *
 * Three passes, median per turn. The first pass also pays for the cold
 * caches and the connection, so it is reported separately rather than
 * folded in -- both numbers are real and only one of them is the demo.
 */
const RUNS = 3;

const totals: Array<{ say: string; ms: number; firstSound: number; spans: Span[] }> = [];
const byTurn = new Map<string, { ms: number[]; sound: number[] }>();

for (let run = 0; run < RUNS; run++) {
await reset();

for (const say of SCRIPT) {
  /**
   * FIRST SOUND IS THE NUMBER THAT MATTERS, and it is not the total.
   *
   * A caller does not experience a turn, they experience the silence
   * before the shop starts talking. Every sentence after the first is
   * synthesised while they are already listening to the one before it --
   * that is the whole point of streaming sentence by sentence, and it
   * means the total stops being the wait. Measuring handle() end to end,
   * which is all this script did at first, measures something no
   * customer ever feels.
   */
  let firstSentenceAt = 0;
  let firstSound = 0;
  const at = Date.now();

  const { spans, totalMs } = await profile(async () =>
    handle(inbound(say), {
      onSentence: async (sentence) => {
        if (firstSentenceAt) return;
        firstSentenceAt = Date.now() - at;
        await speak(sentence);
        firstSound = Date.now() - at;
      },
    }));

  const seen = byTurn.get(say) ?? { ms: [], sound: [] };
  seen.ms.push(totalMs);
  if (firstSound) seen.sound.push(firstSound);
  byTurn.set(say, seen);

  // only the first pass prints its tree; three copies is noise
  if (run === 0) {
    totals.push({ say, ms: totalMs, firstSound, spans });
    console.log(`\n${'='.repeat(64)}\n> ${say}`);
    console.log(report(spans, totalMs));
    console.log(`\n  first sentence ${firstSentenceAt}ms -> first sound ${firstSound}ms`);
  }
}
}

/**
 * The mouth, measured on its own.
 *
 * One sentence, because that is what the caller waits for -- the whole
 * point of streaming sentence by sentence is that nobody waits for the
 * last one. If this number is large, no amount of database work will fix
 * the silence at the start of a turn.
 */
console.log(`\n${'='.repeat(64)}\nTTS, first sentence only`);
for (const line of ['Ji, atta rakh diya.', 'Aur kuch chahiye?']) {
  const at = Date.now();
  const said = await speak(line);
  console.log(`  ${String(Date.now() - at).padStart(5)}ms  ${said ? `${said.audio.length} bytes` : 'FAILED'}  "${line}"`);
}

/** median, not mean: one slow turn drags an average somewhere no turn was */
const mid = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

console.log(`\n${'='.repeat(64)}\nmedian of ${RUNS} runs`);
console.log('   total  1st sound   spread');
for (const say of SCRIPT) {
  const t = byTurn.get(say)!;
  const lo = Math.min(...t.ms);
  const hi = Math.max(...t.ms);
  console.log(
    `  ${String(mid(t.ms)).padStart(6)}ms ${String(mid(t.sound)).padStart(7)}ms`
    + `  ${String(lo).padStart(5)}-${String(hi).padEnd(5)}  ${say}`,
  );
}

const allSound = SCRIPT.flatMap((s) => byTurn.get(s)!.sound);
const allMs = SCRIPT.flatMap((s) => byTurn.get(s)!.ms);
console.log(`\n  cold (first turn of run 1)  ${totals[0]!.ms}ms total, ${totals[0]!.firstSound}ms to first sound`);
console.log(`  median across every turn    ${mid(allMs)}ms total`);
console.log(`  median across every turn    ${mid(allSound)}ms to FIRST SOUND`);

await prisma.$disconnect();
