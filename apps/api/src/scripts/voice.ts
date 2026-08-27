import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma, Prisma } from '@nukkad/db';
import { voiceTurn } from '../services/voice/turn.js';

/**
 * THE VOICE AGENT, WITHOUT A PHONE.
 *
 *   npm run voice --workspace=@nukkad/api -- clip.wav [more.wav ...]
 *
 * Every clip is one turn of the same conversation, through the identical
 * function a real call uses -- transcribe, decide, resolve, reply, speak.
 * The only thing missing is telephony, which is also the only thing that
 * costs money.
 *
 * THAT IS THE POINT. A phone call is where you FIND a bug and the worst
 * possible place to fix one: it costs credit, it cannot be repeated
 * exactly, and you cannot diff two of them. So record the call audio
 * once, drop it in media/, and replay it here as many times as it takes.
 * Every failure becomes a permanent fixture and the same bug can never
 * cost a second call.
 *
 * The trace is printed in full and is meant to be copied out whole --
 * what the ear heard is nearly always where a voice bug is visible, and
 * it is exactly the line you cannot see from the handset.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const HOUSEHOLD = '+918979560165';
const SHOP = '+919927306131';

const clips = process.argv.slice(2);
if (!clips.length) {
  console.error('usage: npm run voice --workspace=@nukkad/api -- <clip.wav> [more.wav ...]');
  process.exit(1);
}

const line = (k: string, v: string | number) => console.log(`  ${k.padEnd(9)} ${v}`);

async function main() {
  /**
   * Each run starts from an empty conversation, because a stale basket
   * or a stale referent from an hour ago makes a trace impossible to
   * read. Pass several clips to keep state ACROSS them, which is how
   * you test "yeh" and "bas bhej do".
   */
  await prisma.conversation.updateMany({
    where: { channel: 'sim', peerPhone: HOUSEHOLD },
    data: { state: 'IDLE', contextJson: Prisma.DbNull },
  });

  const outDir = resolve(ROOT, 'media', 'voice');
  await mkdir(outDir, { recursive: true });

  for (const [i, clip] of clips.entries()) {
    const path = resolve(ROOT, clip);
    const audio = await readFile(path);

    console.log(`\n${'='.repeat(64)}`);
    console.log(`turn ${i + 1}  ${basename(clip)}  (${(audio.length / 1024).toFixed(0)} KB)`);
    console.log('='.repeat(64));

    const { trace, audio: out } = await voiceTurn(audio, {
      phone: HOUSEHOLD,
      shopPhone: SHOP,
      mime: 'audio/wav',
    });

    line('HEARD', `"${trace.heard}"`);
    if (trace.heardRaw && trace.heardRaw !== trace.heard) {
      line('', `raw: ${trace.heardRaw}`);
    }
    line('', `${trace.asrEngine}, ${trace.asrMs}ms`);
    console.log();
    line('ACTION', `${trace.action} / ${trace.goal}`);
    console.log();
    line('SAID', trace.spoken);
    if (trace.reply !== trace.spoken) {
      // the ledger is shown but never spoken -- see speakable() in turn.ts
      console.log(trace.reply.slice(trace.spoken.length).replace(/^/gm, '           '));
    }
    console.log();
    line('BASKET', trace.basket.length ? trace.basket.join(', ') : '(empty)');
    line('"YEH"', trace.lastNamed.length ? trace.lastNamed.join(', ') : '(nothing)');
    console.log();
    line('TIMING', `${trace.asrMs}ms ear + ${trace.totalMs - trace.asrMs - trace.ttsMs}ms think + ${trace.ttsMs}ms mouth = ${trace.totalMs}ms`);

    if (out) {
      const heard = resolve(outDir, `reply-${i + 1}.wav`);
      await writeFile(heard, out);
      line('AUDIO', `media/voice/reply-${i + 1}.wav  (${(out.length / 1024).toFixed(0)} KB)`);
    } else {
      line('AUDIO', 'none -- TTS unavailable, text still worked');
    }
  }

  console.log();
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
