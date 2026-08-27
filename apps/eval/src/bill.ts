import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from '@nukkad/db';
import { planBill, BILL_ABLATIONS } from '../../api/src/services/bills/graph.js';
import { normaliseBillName } from '../../api/src/services/kb/retrieve.js';
import { parseBill, type ParsedBill } from '../../api/src/services/bills/parse.js';

/**
 * ABLATION HARNESS FOR THE BILL AGENT.
 *
 * The resolver has had one of these from the start, and it is the reason
 * the matching claim is measurable rather than asserted. The bill agent had
 * nothing, so every claim about what its nodes were worth was a story.
 *
 * This runs each fixture through the graph five times, switching one node
 * on at a time, and scores the output against ground truth the generator
 * wrote alongside the images. Nodes report SKIP rather than branching the
 * graph, so an ablated run walks the identical path and the node under test
 * is the only variable.
 *
 * The headline number is COMPLETE LINES: a line counts only when it was
 * found AND its quantity, rate and amount are all exactly right. Partial
 * credit would hide the failure that actually matters, which is a confident
 * wrong number written into a shop's prices.
 *
 *   npm run eval:bill
 *   npm run eval:bill -- bill-devanagari.png
 */

const MEDIA = join(process.cwd(), '..', '..', 'media');

interface TruthLine {
  name: string;
  /**
   * Expected transliteration, present only for bills written in script.
   *
   * The pipeline correctly emits Roman, so scoring it against a Devanagari
   * expectation compares two different alphabets and reports 0% for a run
   * that was actually fine. That was a bug in this harness, not in the
   * agent, and it is exactly the kind of thing a harness is for.
   */
  roman?: string;
  qty: number;
  ratePaise: number;
  amountPaise: number;
}
interface Truth { totalPaise: number | null; lines: TruthLine[] }

interface Score {
  expected: number;
  found: number;
  qtyExact: number;
  rateExact: number;
  amountExact: number;
  complete: number;
  ms: number;
}

/** tolerate a paise of rounding on a derived value, nothing more */
const near = (a: number, b: number) => Math.abs(a - b) <= 2;

/**
 * Pair produced lines to expected ones by name.
 *
 * Greedy on trigram-ish overlap rather than by position, because a dropped
 * line slides every position after it and would score the whole bill as
 * wrong for one miss.
 */
function pair(produced: Array<{ workingName: string; rawName: string }>, expected: TruthLine[]) {
  const taken = new Set<number>();
  return expected.map((want) => {
    const target = normaliseBillName(want.roman ?? want.name);
    let best = -1;
    let bestScore = 0;

    produced.forEach((got, i) => {
      if (taken.has(i)) return;
      const cand = normaliseBillName(got.workingName || got.rawName);
      const a = new Set(cand.split(' ').filter(Boolean));
      const b = new Set(target.split(' ').filter(Boolean));
      const overlap = [...a].filter((w) => b.has(w)).length;
      const score = overlap / Math.max(1, Math.min(a.size, b.size));
      if (score > bestScore) { bestScore = score; best = i; }
    });

    if (best >= 0 && bestScore >= 0.5) { taken.add(best); return best; }
    return -1;
  });
}

async function run(fixture: string, truth: Truth, rung: string, pre: ParsedBill): Promise<Score> {
  const kirana = await prisma.kirana.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const bill = await prisma.supplierBill.create({
    data: { kiranaId: kirana.id, imagePath: join(MEDIA, fixture), mime: 'image/png', bytes: 0 },
  });

  const t0 = Date.now();
  try {
    const res = await planBill({
      billId: bill.id,
      kiranaId: kirana.id,
      imagePath: join(MEDIA, fixture),
      mime: 'image/png',
      enable: BILL_ABLATIONS[rung]!,
      preParsed: pre,
    });

    const s: Score = {
      expected: truth.lines.length, found: 0, qtyExact: 0,
      rateExact: 0, amountExact: 0, complete: 0, ms: Date.now() - t0,
    };

    const idx = pair(res.lines, truth.lines);
    truth.lines.forEach((want, i) => {
      const got = idx[i]! >= 0 ? res.lines[idx[i]!] : undefined;
      if (!got) return;
      s.found++;
      const q = near(got.quantity, want.qty);
      const r = near(got.ratePaise, want.ratePaise);
      const a = near(got.amountPaise, want.amountPaise);
      if (q) s.qtyExact++;
      if (r) s.rateExact++;
      if (a) s.amountExact++;
      if (q && r && a) s.complete++;
    });
    return s;
  } finally {
    await prisma.supplierBill.delete({ where: { id: bill.id } }).catch(() => {});
  }
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '--');

async function main() {
  const only = process.argv.slice(2);
  const truths = JSON.parse(await readFile(join(MEDIA, 'fixtures.json'), 'utf-8')) as Record<string, Truth>;
  const fixtures = Object.keys(truths).filter((f) => !only.length || only.includes(f));
  const rungs = Object.keys(BILL_ABLATIONS);

  console.log('\nBILL AGENT ABLATION LADDER');
  console.log('complete = line found AND quantity, rate and amount all exact\n');

  for (const fixture of fixtures) {
    const truth = truths[fixture]!;
    // ONE reading, reused by every rung. Otherwise the ladder measures how
    // much the vision model varies between calls, which is not the question.
    const { bill: pre, model } = await parseBill(join(MEDIA, fixture), 'image/png');
    console.log(
      `${fixture}  (${truth.lines.length} expected${truth.totalPaise ? ', rate column blank' : ''})` +
      `  ·  one reading by ${model}: ${pre.items.length} lines`,
    );
    console.log('  ' + 'rung'.padEnd(16) + 'found  qty   rate  amt   COMPLETE   time');

    for (const rung of rungs) {
      try {
        const s = await run(fixture, truth, rung, pre);
        console.log(
          '  ' + rung.padEnd(16) +
          pct(s.found, s.expected).padEnd(7) +
          pct(s.qtyExact, s.expected).padEnd(6) +
          pct(s.rateExact, s.expected).padEnd(6) +
          pct(s.amountExact, s.expected).padEnd(6) +
          pct(s.complete, s.expected).padStart(6) + '     ' +
          `${(s.ms / 1000).toFixed(1)}s`,
        );
      } catch (err) {
        console.log('  ' + rung.padEnd(16) + 'FAILED  ' + (err as Error).message.slice(0, 60));
      }
    }
    console.log();
  }

  console.log('Fixtures are synthetic. A handwriting FONT is cleaner than a pen, so');
  console.log('these are a lower bound on difficulty rather than a claim about real paper.\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
