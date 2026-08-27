import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { z } from 'zod';
import { prisma } from '@nukkad/db';
import { groq } from '../../lib/groq.js';
import { env } from '../../config/env.js';
import { parseBill, type ParsedBill } from './parse.js';
import {
  retrieveKb, retrieveSkus, normaliseBillName, MATCH,
  type KbHit, type SkuHit,
} from '../kb/retrieve.js';

/**
 * THE BILL AGENT.
 *
 * A photograph of a wholesale bill becomes a reviewed plan for a shop's
 * catalogue. It is a graph rather than a script because the steps have
 * genuinely different failure modes and need different handling: vision
 * can misread and should retry, retrieval can come back empty, and a match
 * decision can be too close to call and must escalate to a human instead
 * of guessing.
 *
 *   extract ─▶ normalise ─▶ repair ─▶ verify ─▶ retrieve
 *             ─▶ reconcile ─▶ price ─▶ alias ─▶ critic ─▶ persist
 *      │
 *      └─(unreadable, retries exhausted)─────────────────────────────────▶ fail
 *
 * TWO RULES HOLD THE WHOLE THING TOGETHER.
 *
 * 1. THE MODEL NEVER FREE-RECALLS. Every judgement it makes is over
 *    candidates retrieved from real rows -- this shop's catalogue, or the
 *    product knowledge base. It picks from a list or it declines. That is
 *    what makes hallucination structurally hard rather than merely
 *    discouraged by a prompt.
 *
 * 2. ARITHMETIC IS NOT THE MODEL'S JOB. Scores, price deltas and margins
 *    are computed in code. The model is asked only for judgements that are
 *    actually linguistic: is this bill line the same product as that
 *    catalogue row, and what would a household call it.
 */

/* ------------------------------------------------------------------ types */

export type Decision = 'RESTOCK' | 'NEW' | 'AMBIGUOUS' | 'SKIPPED';

export interface PlannedLine {
  /** verbatim from the bill, original script. NEVER overwritten. */
  rawName: string;
  /** Roman working form used for retrieval. Equals rawName when already Roman. */
  workingName: string;
  /** English gloss, when the line needed transliterating */
  gloss: string | null;
  /** normalised unit from the quantity cell: kg, pc, peti, bori */
  unit: string | null;
  /** the Pack column, when the bill keeps size separate from name */
  pack: string | null;
  /** printed MRP. A sound default selling price; NOT the price paid. */
  mrpPaise: number | null;
  /** pre-tax, pre-discount unit price off a GST invoice */
  listPricePaise: number | null;
  discPct: number | null;
  taxPct: number | null;
  /** a quantity with no amount. Never priced, never counted in the total. */
  isFree: boolean;
  quantity: number;
  ratePaise: number;
  amountPaise: number;
  /** which numbers were DERIVED rather than read off the paper */
  derived: string[];

  decision: Decision;
  confidence: number;
  reasoning: string;

  skuId: string | null;
  matchedName: string | null;

  candidates: Array<{ id: string; name: string; score: number }>;
  kbHits: Array<{ canonical: string; brand: string; score: number }>;

  priceDeltaPaise: number | null;
  proposedSellPaise: number;
  suggestedAliases: string[];

  /** two readings disagreed, or the arithmetic on the line did not close */
  disputed: boolean;
  disputeNote: string | null;
}

export interface StepLog {
  node: string;
  status: 'OK' | 'RETRY' | 'FAIL' | 'SKIP';
  ms: number;
  note?: string;
  detail?: unknown;
}

/* -------------------------------------------------------------- ablation */

/**
 * Which nodes run. Exists so the eval harness can measure what each one is
 * actually worth rather than asserting it, the same way the resolver's
 * ablation ladder does for matching.
 */
export interface Ablation {
  normalise: boolean;
  repair: boolean;
  verify: boolean;
  critic: boolean;
}

export const FULL: Ablation = { normalise: true, repair: true, verify: true, critic: true };

/** The ladder, each rung adding one node to the one before it. */
/**
 * ORDER MATTERS, and getting it wrong hides the thing you are measuring.
 *
 * normalise comes before repair on purpose. With a Devanagari bill still in
 * Devanagari, no line matches anything, so every metric reads zero and
 * repair's contribution is invisible underneath a matching failure. Unlock
 * matching first, and then repair's rate derivation is the only thing that
 * moves.
 */
export const BILL_ABLATIONS: Record<string, Ablation> = {
  'extract-only':   { normalise: false, repair: false, verify: false, critic: false },
  'plus-normalise': { normalise: true,  repair: false, verify: false, critic: false },
  'plus-repair':    { normalise: true,  repair: true,  verify: false, critic: false },
  'plus-verify':    { normalise: true,  repair: true,  verify: true,  critic: false },
  'plus-critic':    FULL,
};

/* ------------------------------------------------------------------ state */

const BillState = Annotation.Root({
  billId: Annotation<string>,
  kiranaId: Annotation<string>,
  imagePath: Annotation<string>,
  mime: Annotation<string>,
  markupPct: Annotation<number>,
  /**
   * Which nodes are allowed to run. Every node reads this and reports SKIP
   * rather than branching the graph, so an ablated run walks exactly the
   * same path and the only variable is the node under test.
   */
  enable: Annotation<Ablation>({ reducer: (_p, n) => n, default: () => FULL }),

  parsed: Annotation<ParsedBill | null>,
  /**
   * A reading supplied from outside, which makes extract a no-op.
   *
   * Exists for the ablation harness. Re-reading the photograph on every
   * rung means each rung sees a slightly different extraction, so the
   * ladder measures vision variance instead of the node under test -- the
   * first version of this harness showed critic taking a fixture from 40%
   * to 100%, which is impossible, since critic cannot change which lines
   * were found. Pinning the extraction makes the node the only variable.
   */
  preParsed: Annotation<ParsedBill | null>({ reducer: (_p, n) => n, default: () => null }),
  lines: Annotation<PlannedLine[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  // steps accumulate across nodes rather than replacing, so the trace the
  // review screen replays is the whole run and not just the last node
  steps: Annotation<StepLog[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  /** bill-line index -> what did not add up about it */
  disputes: Annotation<Record<number, string>>({ reducer: (_p, n) => n, default: () => ({}) }),
  /** bill-line index -> transliteration, gloss, unit */
  script: Annotation<Record<number, { roman: string; english: string; unit: string | null; agreed: boolean }>>(
    { reducer: (_p, n) => n, default: () => ({}) },
  ),
  /** bill-line index -> which numbers we solved for rather than read */
  repairs: Annotation<Record<number, string[]>>({ reducer: (_p, n) => n, default: () => ({}) }),
  attempts: Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
  failure: Annotation<string | null>({ reducer: (_p, n) => n, default: () => null }),
});

type State = typeof BillState.State;

/* ------------------------------------------------------------ node: extract */

/**
 * Vision pass. Retries once on the faster model, because the usual failure
 * is a malformed JSON envelope rather than genuine illegibility, and a
 * different decoder often just gets it right.
 */
async function extract(s: State): Promise<Partial<State>> {
  const t0 = Date.now();

  if (s.preParsed) {
    return {
      parsed: s.preParsed,
      attempts: 1,
      failure: null,
      steps: [{ node: 'extract', status: 'SKIP', ms: 0, note: 'reading supplied by the caller' }],
    };
  }

  const attempt = s.attempts + 1;

  try {
    const { bill, model, latencyMs } = await parseBill(s.imagePath, s.mime, attempt > 1);
    return {
      parsed: bill,
      attempts: attempt,
      failure: null,
      steps: [{
        node: 'extract',
        status: attempt > 1 ? 'RETRY' : 'OK',
        ms: Date.now() - t0,
        note: `${bill.items.length} lines read by ${model} in ${latencyMs}ms`,
        detail: { supplier: bill.supplier, billNo: bill.billNo, model, attempt },
      }],
    };
  } catch (err) {
    return {
      attempts: attempt,
      failure: (err as Error).message,
      steps: [{
        node: 'extract',
        status: attempt >= 2 ? 'FAIL' : 'RETRY',
        ms: Date.now() - t0,
        note: (err as Error).message,
      }],
    };
  }
}

/** Retry once, then give up rather than burning tokens on an unreadable photo. */
function afterExtract(s: State): 'normalise' | 'extract' | typeof END {
  if (s.parsed) return 'normalise';
  return s.attempts < 2 ? 'extract' : END;
}

/* ------------------------------------------------------------ concurrency */

/**
 * Run an async map with a ceiling on how many are in flight.
 *
 * Promise.all over the lines of a bill looks harmless until the bill has
 * eleven of them: retrieve issues two queries per line, so twenty-two
 * connections open at once and the Supabase session pooler -- fifteen
 * clients, and that is the plan's limit, not a setting -- starts refusing
 * them. The eval harness surfaced this on the first Devanagari run; a shop
 * photographing a full page of stock would have hit it in production.
 *
 * Four at a time keeps the pool comfortable and costs almost nothing in
 * wall clock, because each unit is dominated by network latency anyway.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });

  await Promise.all(workers);
  return out;
}

const DB_CONCURRENCY = 4;

/* --------------------------------------------------------- node: normalise */

const scriptSchema = z.object({
  roman: z.string().min(1).max(80),
  english: z.string().min(1).max(80),
  unit: z.string().max(12).nullable().default(null),
});

const SCRIPT_PROMPT = [
  'An Indian wholesale bill line, possibly written in Devanagari or another',
  'Indian script, possibly in Hinglish, possibly in English.',
  '',
  'Return ONLY JSON: {"roman":"...","english":"...","unit":"..."}',
  '',
  '- roman: the name TRANSLITERATED into Roman letters, as an Indian person',
  '  would type it. आटा -> "atta". मसूर दाल -> "masoor dal". Keep it a',
  '  transliteration, not a translation.',
  '- english: what the product IS in English. आटा -> "wheat flour".',
  '  मसूर दाल -> "red lentil". These are different jobs; do both.',
  '- unit: the unit from the quantity text, normalised to one of',
  '  kg, g, l, ml, pc, pkt, dz, peti, bori. "8 पेटी" -> "peti".',
  '  "90kg" -> "kg". "200pcs" -> "pc". null if there is no unit.',
  '- If the line is already Roman, roman is the line unchanged.',
].join('\n');

const isRoman = (t: string) => !/[^\u0000-\u024F]/.test(t);

/**
 * SCRIPT AND LANGUAGE, handled as retrieval rather than translation.
 *
 * A Devanagari bill is not a translation problem to be solved with a
 * Hindi-to-English dictionary. Dictionaries fail on exactly the cases that
 * matter: handwriting variants, regional spellings, a shopkeeper writing
 * तेल for one brand of oil and रिफाइंड for another.
 *
 * So this node asks for TWO INDEPENDENT READINGS of each foreign-script
 * line -- a transliteration and an English gloss -- and then retrieves both
 * against the knowledge base. Agreement between two different routes to the
 * same catalogue entry is evidence. Divergence is a signal to slow down.
 *
 * Neither reading overwrites rawName. The bill said what it said, and the
 * review screen shows the owner the original beside what we made of it.
 */
async function normalise(s: State): Promise<Partial<State>> {
  if (!s.enable.normalise) {
    return { script: {}, steps: [{ node: 'normalise', status: 'SKIP', ms: 0, note: 'disabled for this run' }] };
  }
  const t0 = Date.now();
  const items = s.parsed?.items ?? [];
  const foreign = items.filter((i) => !isRoman(i.name));

  if (!foreign.length) {
    return {
      script: {},
      steps: [{ node: 'normalise', status: 'SKIP', ms: Date.now() - t0, note: 'already in Roman script' }],
    };
  }

  const out: Record<number, { roman: string; english: string; unit: string | null; agreed: boolean }> = {};
  let agreed = 0;

  await mapLimit(items, DB_CONCURRENCY, async (it, i) => {
    if (isRoman(it.name)) return;
    try {
      const res = await groq.chat.completions.create({
        model: env.GROQ_LLM_MODEL_FAST,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SCRIPT_PROMPT },
          { role: 'user', content: `LINE: ${it.name}\nQUANTITY CELL: ${it.qtyText ?? '(none)'}` },
        ],
      });
      const p = scriptSchema.safeParse(JSON.parse(res.choices[0]?.message?.content ?? '{}'));
      if (!p.success) return;

      // do the two readings reach the same shelf? Retrieval decides, not us.
      const [byRoman, byEnglish] = await Promise.all([
        retrieveKb(p.data.roman, 1),
        retrieveKb(p.data.english, 1),
      ]);
      const same =
        !!byRoman[0] && !!byEnglish[0] && byRoman[0].id === byEnglish[0].id;
      if (same) agreed++;

      out[i] = { roman: p.data.roman, english: p.data.english, unit: p.data.unit, agreed: same };
    } catch {
      /* leave the line in its original script; retrieval will simply miss */
    }
  });

  const done = Object.keys(out).length;
  return {
    script: out,
    steps: [{
      node: 'normalise',
      status: 'OK',
      ms: Date.now() - t0,
      note: `${done}/${foreign.length} non-Roman lines transliterated · ${agreed} where the transliteration and the English gloss retrieved the same product`,
    }],
  };
}

/* ------------------------------------------------------------ node: repair */

/**
 * CONSTRAINT REPAIR.
 *
 * Every bill line is three numbers tied by one equation:
 *
 *     quantity x rate = amount
 *
 * Give it any two and the third follows. Plenty of real wholesale books
 * fill in only Quantity and Amount and leave Rate blank, because the
 * shopkeeper does the division in his head. The honest thing for a reader
 * to report is null, and the honest thing for us to do with a null is
 * SOLVE for it -- not to reject the bill, which is what used to happen.
 *
 * Anything derived here is labelled as derived. It goes to the owner marked
 * as our arithmetic rather than as something printed on their paper, which
 * is a distinction they are entitled to.
 */
async function repair(s: State): Promise<Partial<State>> {
  if (!s.enable.repair) {
    return { repairs: {}, steps: [{ node: 'repair', status: 'SKIP', ms: 0, note: 'disabled for this run' }] };
  }
  const t0 = Date.now();
  const items = s.parsed?.items ?? [];

  let derivedRate = 0, derivedAmount = 0, unsolvable = 0, freebies = 0;
  const fixed = items.map((it) => {
    const qty = it.qty;
    const rate = it.ratePaise;
    const amount = it.amountPaise;

    // A free item is a quantity and nothing else. There is no equation to
    // solve and no price to find: it is stock arriving at zero cost.
    if (it.free || (amount === null && rate === null && it.mrpPaise !== null)) {
      if (it.free) {
        freebies++;
        return { ...it, ratePaise: 0, amountPaise: 0, derived: ['free'] as string[] };
      }
    }

    /**
     * A GST invoice gives list price, discount and tax rather than a rate.
     * The amount already has both applied, so the honest unit cost is the
     * amount divided by the quantity -- what the shop actually parted with
     * per unit, tax included -- and NOT the list price.
     */
    const gst =
      it.listPricePaise !== null && (it.discPct !== null || it.taxPct !== null);

    if (gst && amount === null) {
      const base = qty * it.listPricePaise!;
      const afterDisc = base * (1 - (it.discPct ?? 0) / 100);
      const withTax = Math.round(afterDisc * (1 + (it.taxPct ?? 0) / 100));
      derivedAmount++;
      return { ...it, ratePaise: Math.round(withTax / qty), amountPaise: withTax, derived: ['amount-from-gst'] };
    }
    if (gst && amount !== null) {
      derivedRate++;
      return { ...it, ratePaise: Math.round(amount / qty), amountPaise: amount, derived: ['rate-from-gst'] };
    }

    if (rate !== null && amount !== null) return { ...it, ratePaise: rate, amountPaise: amount, derived: [] as string[] };

    if (rate === null && amount !== null && qty > 0) {
      derivedRate++;
      return { ...it, ratePaise: Math.round(amount / qty), amountPaise: amount, derived: ['rate'] };
    }
    if (amount === null && rate !== null) {
      derivedAmount++;
      return { ...it, ratePaise: rate, amountPaise: Math.round(qty * rate), derived: ['amount'] };
    }

    // Only MRP survives. It is the printed ceiling rather than the price
    // paid, so it is used as a last resort and labelled as such: a
    // discounted line priced from MRP overstates what the shop spent.
    if (amount === null && rate === null && it.mrpPaise !== null) {
      derivedAmount++;
      return {
        ...it,
        ratePaise: it.mrpPaise,
        amountPaise: Math.round(qty * it.mrpPaise),
        derived: ['amount-from-mrp'],
      };
    }

    // one number and no equation to stand it up: cannot be priced at all
    unsolvable++;
    return { ...it, ratePaise: rate ?? 0, amountPaise: amount ?? 0, derived: ['unsolvable'] };
  });

  const parts = [
    derivedRate ? `${derivedRate} rate${derivedRate === 1 ? '' : 's'} worked out from amount / quantity` : '',
    derivedAmount ? `${derivedAmount} amount${derivedAmount === 1 ? '' : 's'} worked out from quantity x rate` : '',
    freebies ? `${freebies} free item${freebies === 1 ? '' : 's'} priced at zero` : '',
    unsolvable ? `${unsolvable} could not be solved` : '',
  ].filter(Boolean);

  return {
    parsed: s.parsed ? { ...s.parsed, items: fixed } : null,
    repairs: Object.fromEntries(fixed.map((f, i) => [i, f.derived])),
    steps: [{
      node: 'repair',
      status: unsolvable ? 'RETRY' : 'OK',
      ms: Date.now() - t0,
      note: parts.length ? parts.join(' · ') : 'every line already carried all three numbers',
    }],
  };
}

/* ------------------------------------------------------------ node: verify */

/**
 * ARITHMETIC CROSS-CHECK, then a second opinion where it fails.
 *
 * This is the node that makes handwriting safe, and it is worth being
 * precise about why. A vision model reading a printed bill fails loudly:
 * it returns nothing, or garbage you can see. Reading HANDWRITING it fails
 * QUIETLY -- a 7 read as a 1, a 6 read as a 5 -- and a misread rate does
 * not look like an error downstream. It looks like a price. It gets
 * written to the catalogue, and the shop sells at it.
 *
 * The fix is not a better OCR model. It is that a bill already carries its
 * own redundancy: every line states quantity, rate AND amount, and the
 * three have to agree. Checking qty x rate == amount catches single-digit
 * misreads deterministically, with no model and no GPU.
 *
 * Only when that check fails do we spend a second vision call, on the
 * OTHER model, and compare the two readings line by line. Agreement is
 * evidence; disagreement is escalated to the owner rather than resolved by
 * picking a favourite. Two models confidently disagreeing about a number
 * is precisely the case where a machine should stop.
 */

/** paise, absolute, to absorb rounding in a rate like 46.67 */
const ARITH_TOLERANCE = 200;

function arithmeticOf(items: ParsedBill['items'], repairs: Record<number, string[]>) {
  return items.map((it, i) => {
    // Derived numbers satisfy the equation by construction; checking them
    // would only ever confirm our own arithmetic. The check is for what was
    // actually READ off the paper.
    if (it.free || !it.amountPaise) return { ok: true, note: null as string | null };

    /**
     * Where a GST invoice gave us every part, check the WHOLE equation.
     * This is the one case worth checking even though repair touched the
     * line, because all four numbers came off the paper independently and
     * the arithmetic between them is a genuine test of the reading.
     */
    if (it.listPricePaise !== null && (it.discPct !== null || it.taxPct !== null)) {
      const base = it.qty * it.listPricePaise;
      const full = Math.round(base * (1 - (it.discPct ?? 0) / 100) * (1 + (it.taxPct ?? 0) / 100));
      return Math.abs(full - it.amountPaise) <= ARITH_TOLERANCE
        ? { ok: true, note: null }
        : {
            ok: false,
            note: `${it.qty} x ${(it.listPricePaise / 100).toFixed(2)} less ${it.discPct ?? 0}% plus ${it.taxPct ?? 0}% tax is ${(full / 100).toFixed(2)}, but the bill says ${(it.amountPaise / 100).toFixed(2)}`,
          };
    }

    const wasDerived = (repairs[i] ?? []).length > 0;
    if (wasDerived || it.ratePaise === null) return { ok: true, note: null };
    const expected = Math.round(it.qty * it.ratePaise);
    const off = Math.abs(expected - it.amountPaise);
    return off <= ARITH_TOLERANCE
      ? { ok: true, note: null }
      : {
          ok: false,
          note: `${it.qty} x ${(it.ratePaise / 100).toFixed(2)} is ${(expected / 100).toFixed(2)}, but the bill says ${(it.amountPaise / 100).toFixed(2)}`,
        };
  });
}

async function verify(s: State): Promise<Partial<State>> {
  if (!s.enable.verify) {
    return { disputes: {}, steps: [{ node: 'verify', status: 'SKIP', ms: 0, note: 'disabled for this run' }] };
  }
  const t0 = Date.now();
  const items = s.parsed?.items ?? [];
  if (!items.length) {
    return { steps: [{ node: 'verify', status: 'SKIP', ms: Date.now() - t0, note: 'nothing to check' }] };
  }

  const arith = arithmeticOf(items, s.repairs);
  let bad = arith.filter((a) => !a.ok).length;

  /**
   * THE WHOLE-DOCUMENT CHECK, and the most useful one on a handwritten
   * bill: the lines have to sum to the printed total.
   *
   * When they do not, the gap is usually one misread line rather than
   * eleven, so we look for the single line whose amount would close it
   * exactly. Naming the suspect turns "something is wrong somewhere" into
   * "check line four", which is the difference between a warning an owner
   * ignores and one they act on.
   */
  const stated = s.parsed?.totalPaise ?? null;
  const summed = items.reduce((a, it) => a + (it.free ? 0 : it.amountPaise ?? 0), 0);
  let totalNote: string | null = null;
  let wholeReadingSuspect = false;

  if (stated && Math.abs(stated - summed) > ARITH_TOLERANCE) {
    const gap = stated - summed;
    const off = Math.abs(gap) / Math.max(stated, 1);

    /**
     * HOW BADLY the total misses decides how much to distrust.
     *
     * A small gap is one misread digit, and naming the line whose amount
     * matches it turns "something is wrong" into "check line four".
     *
     * A LARGE gap is a different animal. It means the lines we are holding
     * are not the lines on the paper -- a dense thermal receipt where the
     * model invented plausible products, which is precisely the failure this
     * system exists to prevent. Flagging one line there is worse than
     * useless: it implies the other seven were verified when nothing was.
     * Past 10% the whole reading is suspect and every line says so.
     */
    if (off > 0.1) {
      wholeReadingSuspect = true;
      totalNote =
        `these lines add up to ${(summed / 100).toFixed(2)} but the bill says ` +
        `${(stated / 100).toFixed(2)}, a gap of ${Math.round(off * 100)}%. ` +
        `The reading does not match the paper, so no line here is trustworthy. ` +
        `Check every row against the bill before applying it.`;
    } else {
      const suspect = items.findIndex(
        (it) => !it.free && Math.abs(gap) < (it.amountPaise ?? 0) * 2,
      );
      totalNote =
        `lines add up to ${(summed / 100).toFixed(2)} but the bill says ${(stated / 100).toFixed(2)}` +
        (suspect >= 0 ? `; the ${(Math.abs(gap) / 100).toFixed(2)} gap is the size of "${items[suspect]!.name}"` : '');
    }
    bad += 1;
  }

  // everything adds up: the reading is self-consistent, no second call
  if (bad === 0) {
    return {
      disputes: {},
      steps: [{
        node: 'verify',
        status: 'OK',
        ms: Date.now() - t0,
        note: stated
          ? `all ${items.length} lines add up, and they sum to the printed total of ${(stated / 100).toFixed(2)}`
          : `all ${items.length} lines add up (qty x rate = amount)`,
      }],
    };
  }

  // something did not close. Read it again on the other model and compare.
  let second: ParsedBill | null = null;
  try {
    const r = await parseBill(s.imagePath, s.mime, true);
    second = r.bill;
  } catch {
    /* second opinion unavailable; the arithmetic flags still stand */
  }

  const disputes: Record<number, string> = {};

  items.forEach((it, i) => {
    const notes: string[] = [];
    if (!arith[i]!.ok) notes.push(arith[i]!.note!);
    // a whole-document mismatch belongs on every line; putting it only on
    // the first implies the rest were checked and passed
    if (totalNote && (wholeReadingSuspect || i === 0)) notes.push(totalNote);

    if (second) {
      // match by position first, then by name, because a model can drop a
      // line entirely and positions then slide
      const other =
        second.items[i] && normaliseBillName(second.items[i]!.name) === normaliseBillName(it.name)
          ? second.items[i]
          : second.items.find((o) => normaliseBillName(o.name) === normaliseBillName(it.name));

      if (!other) {
        notes.push('the second reading did not find this line at all');
      } else {
        if (other.qty !== it.qty) notes.push(`quantity read as ${it.qty} and ${other.qty}`);
        if (other.ratePaise !== null && it.ratePaise !== null && other.ratePaise !== it.ratePaise) {
          notes.push(`rate read as ${(it.ratePaise / 100).toFixed(2)} and ${(other.ratePaise / 100).toFixed(2)}`);
        }
      }
    }

    if (notes.length) disputes[i] = notes.join('; ');
  });

  const n = Object.keys(disputes).length;
  return {
    disputes,
    steps: [{
      node: 'verify',
      status: n ? 'RETRY' : 'OK',
      ms: Date.now() - t0,
      note: wholeReadingSuspect
        ? `THE READING DOES NOT MATCH THE PAPER: lines total ${(summed / 100).toFixed(2)} against a printed ${((stated ?? 0) / 100).toFixed(2)}. All ${items.length} lines held for checking.`
        : second
          ? `${bad} line${bad === 1 ? '' : 's'} did not add up, so it was read again on the second model: ${n} still disputed`
          : `${bad} line${bad === 1 ? '' : 's'} did not add up and no second opinion was available`,
    }],
  };
}

/* ----------------------------------------------------------- node: retrieve */

/**
 * For every bill line, pull the nearest rows from this shop's catalogue and
 * from the knowledge base. Nothing is decided here; this only assembles the
 * evidence the later nodes are allowed to reason over.
 */
async function retrieve(s: State): Promise<Partial<State>> {
  const t0 = Date.now();
  const items = s.parsed?.items ?? [];

  const lines: PlannedLine[] = await mapLimit(items, DB_CONCURRENCY, async (it, idx) => {
      // retrieval runs on the ROMAN working form. rawName keeps the
      // original script for the review screen.
      const sc = s.script[idx];
      // "5KG" + "SHAKTI BHOG ATTA" is one product. Retail bills split them
      // into separate columns; the catalogue keeps them together.
      const base = sc?.roman ?? it.name;
      const working = it.pack ? `${base} ${it.pack}` : base;
      const [skus, kb] = await Promise.all([
        retrieveSkus(s.kiranaId, working),
        retrieveKb(working),
      ]);

      return {
        rawName: it.name,
        workingName: working,
        gloss: sc?.english ?? null,
        unit: sc?.unit ?? null,
        pack: it.pack,
        mrpPaise: it.mrpPaise,
        listPricePaise: it.listPricePaise,
        discPct: it.discPct,
        taxPct: it.taxPct,
        isFree: !!it.free,
        quantity: it.qty,
        ratePaise: it.ratePaise ?? 0,
        amountPaise: it.amountPaise ?? 0,
        derived: s.repairs[idx] ?? [],
        decision: 'NEW' as Decision,
        confidence: 0,
        reasoning: '',
        skuId: null,
        matchedName: null,
        candidates: skus.map((c) => ({ id: c.id, name: c.name, score: Number(c.score) })),
        kbHits: kb.map((h) => ({ canonical: h.canonical, brand: h.brand, score: Number(h.score) })),
        priceDeltaPaise: null,
        proposedSellPaise: 0,
        suggestedAliases: [],
        disputed: !!s.disputes[idx],
        disputeNote: s.disputes[idx] ?? null,
        _skus: skus,
        _kb: kb,
    } as PlannedLine & { _skus: SkuHit[]; _kb: KbHit[] };
  });

  const withCandidates = lines.filter((l) => l.candidates.length > 0).length;

  return {
    lines,
    steps: [{
      node: 'retrieve',
      status: 'OK',
      ms: Date.now() - t0,
      note: `${lines.length} lines · ${withCandidates} had a catalogue candidate · KB consulted for all`,
    }],
  };
}

/* ---------------------------------------------------------- node: reconcile */

const verdictSchema = z.object({
  same: z.boolean(),
  candidateIndex: z.number().int().min(0).max(9).nullable().default(null),
  why: z.string().max(200),
});

const RECONCILE_PROMPT = [
  'You decide whether a line on an Indian wholesale bill is the SAME product',
  'as one already in a shop\'s catalogue.',
  '',
  'Return ONLY JSON: {"same":true|false,"candidateIndex":<int|null>,"why":"..."}',
  '',
  'RULES:',
  '- Same product means same brand AND same variant. Pack size may differ;',
  '  the shop tracks pack size separately.',
  '- "Aashirvaad Atta" and "Aashirvaad Multigrain Atta" are DIFFERENT.',
  '- "Fortune Sunflower Oil" and "Fortune Refined Sunflower Oil" are the SAME.',
  '- A different brand is always a different product, however similar.',
  '- If nothing in the list is clearly the same product, answer same=false.',
  '- Choose ONLY from the numbered candidates. Never invent one.',
  '- why: one short clause, no preamble.',
].join('\n');

/**
 * Band by score first, and only spend a model call on the middle.
 *
 * A near-exact string match needs no LLM, and neither does a line with no
 * candidate at all. The interesting band is 0.30 to 0.62, where the strings
 * are close but might be two different variants of the same brand -- the
 * one judgement here that is genuinely linguistic.
 */
async function reconcile(s: State): Promise<Partial<State>> {
  const t0 = Date.now();
  let adjudicated = 0;

  const lines = await mapLimit(s.lines, DB_CONCURRENCY, async (line) => {
      const cands = line.candidates;
      const top = cands[0];

      // The numbers on this line are not trusted, so no decision taken from
      // them can be either. Matching the NAME is not the issue; applying a
      // quantity or a rate nobody has confirmed is.
      if (line.disputed) {
        return {
          ...line,
          decision: 'AMBIGUOUS' as Decision,
          confidence: 0,
          skuId: top && top.score >= MATCH.AUTO ? top.id : null,
          matchedName: top && top.score >= MATCH.AUTO ? top.name : null,
          reasoning: `Needs your eyes: ${line.disputeNote}`,
        };
      }

      if (!top || top.score < MATCH.REVIEW) {
        return { ...line, decision: 'NEW' as Decision, confidence: top ? 1 - top.score : 1,
          reasoning: top ? `Closest was "${top.name}" at ${(top.score * 100) | 0}%, too far to be the same thing.`
                         : 'Nothing in the catalogue is close to this name.' };
      }

      // two candidates neck and neck: a coin flip that writes to stock is
      // worse than one question to the owner
      const second = cands[1];
      if (second && top.score - second.score < MATCH.RUNNER_UP_GAP && top.score < MATCH.AUTO) {
        return { ...line, decision: 'AMBIGUOUS' as Decision, confidence: top.score,
          reasoning: `"${top.name}" and "${second.name}" score within ${(MATCH.RUNNER_UP_GAP * 100) | 0}% of each other.` };
      }

      if (top.score >= MATCH.AUTO) {
        return { ...line, decision: 'RESTOCK' as Decision, confidence: top.score, skuId: top.id,
          matchedName: top.name,
          reasoning: `Name matches "${top.name}" at ${(top.score * 100) | 0}%.` };
      }

      // the middle band, where the model earns its place
      adjudicated++;
      try {
        const list = cands.map((c, i) => `${i}. ${c.name}`).join('\n');
        const res = await groq.chat.completions.create({
          model: env.GROQ_LLM_MODEL_FAST,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: RECONCILE_PROMPT },
            { role: 'user', content: `BILL LINE: ${line.rawName}\n\nCANDIDATES:\n${list}` },
          ],
        });
        const v = verdictSchema.safeParse(JSON.parse(res.choices[0]?.message?.content ?? '{}'));

        if (v.success && v.data.same && v.data.candidateIndex !== null) {
          const pick = cands[v.data.candidateIndex];
          if (pick) {
            return { ...line, decision: 'RESTOCK' as Decision, confidence: Math.max(top.score, 0.7),
              skuId: pick.id, matchedName: pick.name, reasoning: v.data.why };
          }
        }
        return { ...line, decision: 'NEW' as Decision, confidence: 1 - top.score,
          reasoning: v.success ? v.data.why : 'Adjudicator could not confirm a match.' };
      } catch {
        // model unavailable: fall back to asking rather than to guessing
        return { ...line, decision: 'AMBIGUOUS' as Decision, confidence: top.score,
          reasoning: `Could not adjudicate automatically; "${top.name}" is the closest.` };
      }
  });

  const n = (d: Decision) => lines.filter((l) => l.decision === d).length;
  return {
    lines,
    steps: [{
      node: 'reconcile',
      status: 'OK',
      ms: Date.now() - t0,
      note: `${n('RESTOCK')} restock · ${n('NEW')} new · ${n('AMBIGUOUS')} need you · ${adjudicated} sent to the adjudicator`,
    }],
  };
}

/* -------------------------------------------------------------- node: price */

/**
 * Price movement, in code.
 *
 * The interesting output is not the new cost, it is the DELTA: a supplier
 * quietly raising a rate 12% is the thing an owner wants to see, and it is
 * invisible if you just overwrite the cost field, which is what the old
 * commit path did.
 *
 * The proposed selling price preserves the shop's OWN margin on a restock
 * rather than applying a flat markup, so a deliberate price on a loss
 * leader is not silently reset by a delivery.
 */
async function price(s: State): Promise<Partial<State>> {
  const t0 = Date.now();

  const ids = s.lines.map((l) => l.skuId).filter((x): x is string => !!x);
  const known = ids.length
    ? await prisma.sku.findMany({
        where: { id: { in: ids } },
        select: { id: true, costPaise: true, sellPaise: true },
      })
    : [];
  const byId = new Map(known.map((k) => [k.id, k]));

  let moved = 0;
  const lines = s.lines.map((l) => {
    const prev = l.skuId ? byId.get(l.skuId) : undefined;

    if (!prev || prev.costPaise === null || prev.costPaise === 0) {
      return {
        ...l,
        priceDeltaPaise: null,
        // A printed MRP beats any markup we could invent: it is the price
        // the manufacturer set and the one the customer expects to see.
        proposedSellPaise: l.mrpPaise ?? Math.round(l.ratePaise * (1 + s.markupPct / 100)),
      };
    }

    const delta = l.ratePaise - prev.costPaise;
    if (delta !== 0) moved++;

    // keep the margin the shop actually had on this item
    const margin = prev.sellPaise / prev.costPaise;
    return {
      ...l,
      priceDeltaPaise: delta,
      proposedSellPaise: Math.round(l.ratePaise * margin),
    };
  });

  return {
    lines,
    steps: [{
      node: 'price',
      status: 'OK',
      ms: Date.now() - t0,
      note: moved
        ? `${moved} item${moved === 1 ? '' : 's'} changed cost since the last bill`
        : 'no cost changes',
    }],
  };
}

/* -------------------------------------------------------------- node: alias */

const aliasSchema = z.object({ aliases: z.array(z.string().min(2).max(40)).max(8) });

const ALIAS_PROMPT = [
  'You give the local names Indian households actually use for a grocery item.',
  '',
  'You are shown REFERENCE entries: real products with the real names people',
  'use for them, retrieved from a curated list. Use them as your evidence.',
  '',
  'Return ONLY JSON: {"aliases":["...","..."]}',
  '',
  'RULES:',
  '- Prefer names that appear in the REFERENCE block. Reuse them verbatim when',
  '  the product is the same kind of thing.',
  '- Roman Hinglish, lowercase, no Devanagari.',
  '- Always include the bare generic ("atta", "tel", "namak"): it is what',
  '  people say most.',
  '- Include romanisation variants people actually type ("aata", "chini").',
  '- Include the brand alone only if people refer to it that way.',
  '- NEVER include the pack size or a number. Quantity is handled elsewhere.',
  '- If the reference block is empty, return at most three names you are sure of.',
  '- Maximum 8. Fewer good ones beats more invented ones.',
].join('\n');

/**
 * Grounded subname generation.
 *
 * This is the highest-leverage node in the graph. Subnames are how a spoken
 * order finds a SKU, so an inventory with real ones is an inventory the
 * resolver rarely has to guess at -- and a guess is where hallucination
 * enters the product at all.
 *
 * The model is handed the actual local names of the nearest known products
 * and told to reuse them. Asked cold it invents confident nonsense; asked
 * with evidence it mostly copies, which is exactly what we want.
 */
async function alias(s: State): Promise<Partial<State>> {
  const t0 = Date.now();
  let generated = 0;
  let grounded = 0;

  const lines = await mapLimit(s.lines, DB_CONCURRENCY, async (l) => {
      // restocks already have their names; only new products need any
      if (l.decision !== 'NEW') return l;

      const kb = (l as PlannedLine & { _kb?: KbHit[] })._kb ?? [];
      const reference = kb
        .map((h) => `- ${(h.brand + ' ' + h.canonical).trim()} (${h.category}): ${h.subnames.join(', ')}`)
        .join('\n');
      if (reference) grounded++;

      try {
        const res = await groq.chat.completions.create({
          model: env.GROQ_LLM_MODEL_FAST,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: ALIAS_PROMPT },
            {
              role: 'user',
              content: `PRODUCT AS PRINTED: ${l.rawName}\n\nREFERENCE:\n${reference || '(nothing close found)'}`,
            },
          ],
        });
        const p = aliasSchema.safeParse(JSON.parse(res.choices[0]?.message?.content ?? '{}'));
        if (!p.success) return l;

        const cleaned = [...new Set(
          p.data.aliases
            .map((a) => a.trim().toLowerCase())
            // a "subname" carrying a digit is a pack size, not a name
            .filter((a) => a && !/\d/.test(a)),
        )];
        generated += cleaned.length;
        return { ...l, suggestedAliases: cleaned };
      } catch {
        return l;
      }
  });

  const newCount = lines.filter((l) => l.decision === 'NEW').length;
  return {
    lines,
    steps: [{
      node: 'alias',
      status: 'OK',
      ms: Date.now() - t0,
      note: `${generated} subnames for ${newCount} new item${newCount === 1 ? '' : 's'} · ${grounded} grounded in the knowledge base`,
    }],
  };
}

/* ------------------------------------------------------------- node: critic */

/**
 * Adversarial pass over the restocks.
 *
 * Every other node is trying to find a match. This one is trying to break
 * it, because the expensive error here is a false positive: merging two
 * different products silently corrupts a stock count and a price, and
 * nobody notices until the shelf disagrees with the screen.
 *
 * A restock that fails this check is demoted to AMBIGUOUS, never to NEW.
 * "I am not sure" must not turn into a duplicate SKU either.
 */
async function critic(s: State): Promise<Partial<State>> {
  if (!s.enable.critic) {
    return { steps: [{ node: 'critic', status: 'SKIP', ms: 0, note: 'disabled for this run' }] };
  }
  const t0 = Date.now();
  const targets = s.lines.filter((l) => l.decision === 'RESTOCK' && l.confidence < 0.9);

  if (!targets.length) {
    return { steps: [{ node: 'critic', status: 'SKIP', ms: Date.now() - t0, note: 'every restock was already near-certain' }] };
  }

  let demoted = 0;
  const checked = new Map<string, boolean>();

  await mapLimit(targets, DB_CONCURRENCY, async (l) => {
    try {
      const res = await groq.chat.completions.create({
        model: env.GROQ_LLM_MODEL_FAST,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'system',
          content: [
            'You are checking a proposed match for mistakes. Try to REFUTE it.',
            'Return ONLY JSON: {"refuted":true|false,"why":"..."}',
            'Refute if the brand differs, the variant differs, or one is a',
            'different product that merely reads similarly.',
            'Do not refute over pack size or spelling alone.',
            'When genuinely unsure, refuted=true. A wrong merge corrupts stock.',
          ].join('\n'),
        }, {
          role: 'user',
          content: `BILL LINE: ${l.rawName}\nPROPOSED MATCH: ${l.matchedName}`,
        }],
      });
      const v = z.object({ refuted: z.boolean(), why: z.string().max(200) })
        .safeParse(JSON.parse(res.choices[0]?.message?.content ?? '{}'));
      if (v.success && v.data.refuted) {
        checked.set(l.rawName, true);
        demoted++;
      }
    } catch {
      /* critic unavailable: leave the original decision alone */
    }
  });

  const lines = s.lines.map((l) =>
    checked.get(l.rawName)
      ? { ...l, decision: 'AMBIGUOUS' as Decision, reasoning: `${l.reasoning} Checker was not convinced, so this is yours to confirm.` }
      : l,
  );

  return {
    lines,
    steps: [{
      node: 'critic',
      status: 'OK',
      ms: Date.now() - t0,
      note: demoted
        ? `${demoted} of ${targets.length} restocks sent back for confirmation`
        : `all ${targets.length} restocks held up`,
    }],
  };
}

/* ------------------------------------------------------------ node: persist */

async function persist(s: State): Promise<Partial<State>> {
  const t0 = Date.now();

  await prisma.$transaction(async (tx) => {
    await tx.supplierBillLine.deleteMany({ where: { billId: s.billId } });
    await tx.billAgentStep.deleteMany({ where: { billId: s.billId } });

    for (const l of s.lines) {
      await tx.supplierBillLine.create({
        data: {
          billId: s.billId,
          rawName: l.rawName,
          quantity: l.quantity,
          ratePaise: l.ratePaise,
          amountPaise: l.amountPaise,
          skuId: l.skuId,
          createSku: l.decision === 'NEW',
          matchScore: l.confidence,
          decision: l.decision,
          confidence: l.confidence,
          reasoning: l.reasoning,
          candidatesJson: { catalogue: l.candidates, kb: l.kbHits },
          priceDeltaPaise: l.priceDeltaPaise,
          proposedSellPaise: l.proposedSellPaise,
          suggestedAliases: l.suggestedAliases,
          disputed: l.disputed,
          disputeNote: l.disputeNote,
          workingName: l.workingName,
          gloss: l.gloss,
          unit: l.unit,
          pack: l.pack,
          mrpPaise: l.mrpPaise,
          isFree: l.isFree,
          derived: l.derived,
        },
      });
    }

    const all = [...s.steps, { node: 'persist', status: 'OK' as const, ms: Date.now() - t0, note: `${s.lines.length} lines written` }];
    await tx.billAgentStep.createMany({
      data: all.map((st, i) => ({
        billId: s.billId,
        seq: i,
        node: st.node,
        status: st.status,
        ms: st.ms,
        note: st.note ?? null,
        detail: (st.detail ?? undefined) as never,
      })),
    });

    await tx.supplierBill.update({
      where: { id: s.billId },
      data: {
        status: 'PLANNED',
        supplierName: s.parsed?.supplier ?? null,
        billNo: s.parsed?.billNo ?? null,
        docType: s.parsed?.docType ?? 'UNKNOWN',
        totalPaise: s.parsed?.totalPaise ?? null,
        agentMs: [...s.steps].reduce((a, b) => a + b.ms, 0) + (Date.now() - t0),
      },
    });
  });

  return { steps: [{ node: 'persist', status: 'OK', ms: Date.now() - t0 }] };
}

/* ------------------------------------------------------------------ wiring */

const workflow = new StateGraph(BillState)
  .addNode('extract', extract)
  .addNode('normalise', normalise)
  .addNode('repair', repair)
  .addNode('verify', verify)
  .addNode('retrieve', retrieve)
  .addNode('reconcile', reconcile)
  .addNode('price', price)
  .addNode('alias', alias)
  .addNode('critic', critic)
  .addNode('persist', persist)
  .addEdge(START, 'extract')
  .addConditionalEdges('extract', afterExtract, ['normalise', 'extract', END])
  .addEdge('normalise', 'repair')
  .addEdge('repair', 'verify')
  .addEdge('verify', 'retrieve')
  .addEdge('retrieve', 'reconcile')
  .addEdge('reconcile', 'price')
  .addEdge('price', 'alias')
  .addEdge('alias', 'critic')
  .addEdge('critic', 'persist')
  .addEdge('persist', END);

export const billAgent = workflow.compile();

export interface AgentResult {
  lines: PlannedLine[];
  steps: StepLog[];
  failure: string | null;
  parsed: ParsedBill | null;
}

export async function planBill(input: {
  billId: string;
  kiranaId: string;
  imagePath: string;
  mime: string;
  markupPct?: number;
  enable?: Ablation;
  preParsed?: ParsedBill;
}): Promise<AgentResult> {
  const out = await billAgent.invoke({
    billId: input.billId,
    kiranaId: input.kiranaId,
    imagePath: input.imagePath,
    mime: input.mime,
    markupPct: input.markupPct ?? 15,
    enable: input.enable ?? FULL,
    preParsed: input.preParsed ?? null,
  });

  return {
    // strip the retrieval scratch fields before this crosses the API boundary
    lines: (out.lines ?? []).map(({ ...l }) => {
      delete (l as Record<string, unknown>)._skus;
      delete (l as Record<string, unknown>)._kb;
      return l;
    }),
    steps: out.steps ?? [],
    failure: out.failure ?? null,
    parsed: out.parsed ?? null,
  };
}
