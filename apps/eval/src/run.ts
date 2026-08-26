import 'dotenv/config';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from '@nukkad/db';
import type { ResolvedLine } from '@nukkad/shared';

import { transcribeGroq } from '../../api/src/services/asr/index.js';
import { extractOrder } from '../../api/src/services/extraction/extract.js';
import { getCatalog } from '../../api/src/services/catalog/cache.js';
import { buildPrior } from '../../api/src/services/resolver/prior.js';
import { rankLine, ABLATIONS } from '../../api/src/services/resolver/rank.js';

import type { GoldenCase, StageResult } from './types.js';
import { scoreLine, toMarkdown } from './score.js';

const FIXTURES = join(process.cwd(), 'fixtures');
const OUT = join(process.cwd(), 'out');

async function loadGolden(): Promise<GoldenCase[]> {
  const real = join(FIXTURES, 'golden.json');
  const example = join(FIXTURES, 'golden.example.json');
  try {
    await access(real);
    return JSON.parse(await readFile(real, 'utf8')) as GoldenCase[];
  } catch {
    console.warn(
      '\n  WARNING: fixtures/golden.json not found, falling back to the EXAMPLE set.\n' +
      '  The example set is typed text, not real voice notes. Numbers from it\n' +
      '  are NOT presentable. Day 2 gate: 30+ real inputs or the project changes.\n',
    );
    return JSON.parse(await readFile(example, 'utf8')) as GoldenCase[];
  }
}

/** Transcribe once per case, then reuse across stages so ASR cost is paid once. */
async function materialise(cases: GoldenCase[]) {
  const out: Array<GoldenCase & { resolvedText: string; asrEngine: string | null; asrMs: number }> = [];
  for (const c of cases) {
    if (c.audio) {
      const t = await transcribeGroq(join(process.cwd(), c.audio));
      out.push({ ...c, resolvedText: t.text, asrEngine: t.engine, asrMs: t.latencyMs });
      console.log(`  asr  ${c.id}  ${t.latencyMs}ms  "${t.text.slice(0, 60)}"`);
    } else {
      out.push({ ...c, resolvedText: c.text ?? '', asrEngine: null, asrMs: 0 });
    }
  }
  return out;
}

async function main() {
  const cases = await loadGolden();
  console.log(`\nloaded ${cases.length} golden case(s)\n`);

  const withText = await materialise(cases);

  const results: StageResult[] = [];
  const detail: unknown[] = [];

  for (const [stage, opts] of Object.entries(ABLATIONS)) {
    let lines = 0, top1 = 0, top3 = 0, qty = 0, unresolved = 0, sent = 0, ms = 0;

    for (const c of withText) {
      const hh = await prisma.household.findFirst({ where: { phone: c.householdPhone } });
      if (!hh) { console.warn(`  skip ${c.id}: no household ${c.householdPhone}`); continue; }

      const t0 = Date.now();
      const [catalog, prior] = await Promise.all([
        getCatalog(hh.kiranaId),
        // The prior is the thing being ablated, so build it only when on.
        opts.usePrior ? buildPrior(hh.id) : Promise.resolve(new Map<string, number>()),
      ]);

      const extraction = await extractOrder(c.resolvedText);
      const resolved: ResolvedLine[] = extraction.items.map((it) =>
        rankLine(it.text, it.quantity, it.unit, catalog, prior, opts),
      );
      ms += Date.now() - t0;

      for (const line of resolved) {
        lines++;
        const s = scoreLine(line, c.expected);
        if (s.top1) top1++;
        if (s.top3) top3++;
        if (s.qty) qty++;
        if (!line.chosen) unresolved++;
        if (line.needsDisambiguation) sent++;
        detail.push({ stage, caseId: c.id, sourceText: line.sourceText,
          chosen: line.chosen?.sku.name ?? null, confidence: line.confidence, ...s });
      }
    }

    const pct = (n: number) => (lines ? Math.round((n / lines) * 1000) / 10 : 0);
    results.push({
      stage, cases: withText.length, lines,
      top1: pct(top1), top3: pct(top3), quantityExact: pct(qty),
      unresolved: pct(unresolved), sentToBuyer: pct(sent),
      avgLatencyMs: withText.length ? Math.round(ms / withText.length) : 0,
    });
    console.log(`  ${stage.padEnd(18)} top1=${pct(top1)}%  top3=${pct(top3)}%`);
  }

  await mkdir(OUT, { recursive: true });

  const md = [
    '# Ablation',
    '',
    `Cases: ${withText.length}. Engine: ${withText.find((c) => c.asrEngine)?.asrEngine ?? 'text only'}.`,
    '',
    toMarkdown(results as unknown as Array<Record<string, string | number>>),
    '',
    '## Reading this',
    '',
    'The claim is that transcription errors fatal to entity extraction are',
    'recoverable by retrieval, because the answer is guaranteed to be inside',
    'a few hundred known SKUs and the household prior is strong.',
    '',
    'If `raw` is low and `plus-catalogue` jumps, the claim holds. The delta',
    'IS the product. If they are close, the ranking is not doing the work and',
    'the thesis needs rewriting, which is far better to learn now than on stage.',
  ].join('\n');

  await writeFile(join(OUT, 'ablation.md'), md, 'utf8');
  await writeFile(join(OUT, 'raw.json'), JSON.stringify(detail, null, 2), 'utf8');

  console.log(`\nwrote out/ablation.md and out/raw.json\n`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
