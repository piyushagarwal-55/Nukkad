import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '@nukkad/db';
import { getCatalog } from '../services/catalog/cache.js';
import { buildPrior } from '../services/resolver/prior.js';
import { rankLine } from '../services/resolver/rank.js';
import { extractOrder } from '../services/extraction/extract.js';
import { transcribeGroq, transcribeSarvam, type Transcription } from '../services/asr/index.js';
import { transcribeShunya } from '../services/asr/shunya.js';

/**
 * WHICH ASR ENGINE, DECIDED BY MEASUREMENT.
 *
 *   npm run asr:bench --workspace=@nukkad/api -- [path/to/clip.wav]
 *
 * The thing people get wrong here is scoring ASR by word error rate. WER is
 * the wrong metric for this product. Nothing downstream reads the transcript
 * as prose; the RANKER reads it, and the ranker is constrained to a few
 * hundred known SKUs. An engine that writes "ada" for "atta" still lands the
 * right SKU. An engine that writes flawless Devanagari lands NOTHING, because
 * the resolver's normaliser strips every non-ASCII character and then scores
 * an empty query against the whole catalogue.
 *
 * So the score is: of the items actually spoken, how many come out the far
 * end as the right SKU. Latency is measured on the same calls, because on a
 * voice call latency is not a nicety, it is whether the caller thinks the
 * line has dropped.
 *
 * EVERY ENGINE RUNS N TIMES AND EVERY TRIAL IS PRINTED.
 *
 * That is not padding, it is the correction to a mistake this script made in
 * its first version. Run once, Whisper scored 0 of 3. Run again on the same
 * clip, the same file, the same everything, it scored 2 of 3 -- because the
 * transliteration step is an LLM call and it wrote "aada" the second time
 * where it had written "ada" the first. A single-shot table would have
 * reported whichever run happened to execute, with no hint that the number
 * moves. The spread is part of the result.
 */

/** npm sets cwd to the workspace, so a bare `media/...` finds nothing */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLIP = resolve(ROOT, process.argv[2] ?? 'media/hinglish-test.wav');
const REPEATS = Number(process.env.ASR_BENCH_REPEATS ?? 3);

const HOUSEHOLD = '+918979560165';

/** what the clip says, and what the three product phrases should become */
const SPOKEN = 'bhaiya do kilo atta aur ek litre tel bhej dena, aur haan chai patti bhi';
const WANT = [
  'Aashirvaad Whole Wheat Atta 5kg',
  'Fortune Sunflower Oil 1L',
  'Tata Tea Gold 500g',
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

interface Engine { name: string; run: () => Promise<Transcription | null> }

const ENGINES: Engine[] = [
  { name: 'whisper hi + romanise', run: () => transcribeGroq(CLIP) },
  { name: 'shunya zero-indic en',  run: () => transcribeShunya(CLIP) },
  { name: 'sarvam saaras translit', run: () => transcribeSarvam(CLIP) },
];

async function main() {
  const hh = await prisma.household.findFirstOrThrow({ where: { phone: HOUSEHOLD } });
  const catalog = await getCatalog(hh.kiranaId);
  const prior = await buildPrior(hh.id);

  console.log(`\nclip      ${CLIP}`);
  console.log(`spoken    ${SPOKEN}`);
  console.log(`catalogue ${catalog.length} skus, prior covers ${prior.size}`);
  console.log(`trials    ${REPEATS} per engine\n`);

  const rows: string[] = [];

  for (const eng of ENGINES) {
    console.log(eng.name);

    const latencies: number[] = [];
    const founds: number[] = [];

    for (let trial = 0; trial < REPEATS; trial++) {
      let t: Transcription | null = null;
      try {
        t = await eng.run();
      } catch (err) {
        console.log(`    threw: ${(err as Error).message}`);
        break;
      }
      if (!t) {
        console.log('    not configured, or the call failed');
        break;
      }
      latencies.push(t.latencyMs);

      const ex = await extractOrder(t.text);
      const hits = new Set<string>();
      const marks: string[] = [];
      for (const item of ex.items) {
        const line = rankLine(item.text, item.quantity, item.unit, catalog, prior);
        const got = line.chosen?.sku.name ?? 'UNRESOLVED';
        const ok = WANT.some((w) => norm(w) === norm(got));
        if (ok) hits.add(norm(got));
        marks.push(
          `      ${ok ? 'ok  ' : 'MISS'} '${item.text}' -> ${got}` +
          ` (${line.chosen?.score.toFixed(2) ?? '-'})`,
        );
      }
      founds.push(hits.size);

      console.log(`  trial ${trial + 1}  ${String(t.latencyMs).padStart(5)}ms  ${hits.size}/${WANT.length}`);
      console.log(`      raw   ${t.raw}`);
      // only Whisper has a second script to show; the Indic engines
      // already answer in Roman, which is the entire reason they are here
      if (t.text !== t.raw) console.log(`      roman ${t.text}`);
      marks.forEach((m) => console.log(m));
    }

    if (!latencies.length) { console.log(); continue; }

    const lo = Math.min(...founds), hi = Math.max(...founds);
    rows.push(
      `  ${eng.name.padEnd(24)} ${String(median(latencies)).padStart(5)}ms  ` +
      `${String(Math.min(...latencies)).padStart(5)}-${String(Math.max(...latencies)).padEnd(5)}  ` +
      (lo === hi ? `${lo}/${WANT.length}` : `${lo}-${hi}/${WANT.length}`),
    );
    console.log();
  }

  console.log('  engine                   median   range        found');
  console.log('  ' + '-'.repeat(56));
  rows.forEach((r) => console.log(r));
  console.log();

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
