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
 *   extract ─▶ verify ─▶ retrieve ─▶ reconcile ─▶ price ─▶ alias ─▶ critic ─▶ persist
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
  rawName: string;
  quantity: number;
  ratePaise: number;
  amountPaise: number;

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

/* ------------------------------------------------------------------ state */

const BillState = Annotation.Root({
  billId: Annotation<string>,
  kiranaId: Annotation<string>,
  imagePath: Annotation<string>,
  mime: Annotation<string>,
  markupPct: Annotation<number>,

  parsed: Annotation<ParsedBill | null>,
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
function afterExtract(s: State): 'verify' | 'extract' | typeof END {
  if (s.parsed) return 'verify';
  return s.attempts < 2 ? 'extract' : END;
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

function arithmeticOf(items: ParsedBill['items']) {
  return items.map((it) => {
    const expected = Math.round(it.qty * it.ratePaise);
    // a bill that omits the amount column cannot be cross-checked this way
    if (!it.amountPaise) return { ok: true, note: null as string | null };
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
  const t0 = Date.now();
  const items = s.parsed?.items ?? [];
  if (!items.length) {
    return { steps: [{ node: 'verify', status: 'SKIP', ms: Date.now() - t0, note: 'nothing to check' }] };
  }

  const arith = arithmeticOf(items);
  const bad = arith.filter((a) => !a.ok).length;

  // everything adds up: the reading is self-consistent, no second call
  if (bad === 0) {
    return {
      disputes: {},
      steps: [{
        node: 'verify',
        status: 'OK',
        ms: Date.now() - t0,
        note: `all ${items.length} lines add up (qty x rate = amount)`,
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
        if (other.ratePaise !== it.ratePaise) {
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
      note: second
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

  const lines: PlannedLine[] = await Promise.all(
    items.map(async (it, idx) => {
      const [skus, kb] = await Promise.all([
        retrieveSkus(s.kiranaId, it.name),
        retrieveKb(it.name),
      ]);

      return {
        rawName: it.name,
        quantity: it.qty,
        ratePaise: it.ratePaise,
        amountPaise: it.amountPaise,
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
    }),
  );

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

  const lines = await Promise.all(
    s.lines.map(async (line) => {
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
    }),
  );

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
        proposedSellPaise: Math.round(l.ratePaise * (1 + s.markupPct / 100)),
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

  const lines = await Promise.all(
    s.lines.map(async (l) => {
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
    }),
  );

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
  const t0 = Date.now();
  const targets = s.lines.filter((l) => l.decision === 'RESTOCK' && l.confidence < 0.9);

  if (!targets.length) {
    return { steps: [{ node: 'critic', status: 'SKIP', ms: Date.now() - t0, note: 'every restock was already near-certain' }] };
  }

  let demoted = 0;
  const checked = new Map<string, boolean>();

  await Promise.all(targets.map(async (l) => {
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
  }));

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
  .addNode('verify', verify)
  .addNode('retrieve', retrieve)
  .addNode('reconcile', reconcile)
  .addNode('price', price)
  .addNode('alias', alias)
  .addNode('critic', critic)
  .addNode('persist', persist)
  .addEdge(START, 'extract')
  .addConditionalEdges('extract', afterExtract, ['verify', 'extract', END])
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
}): Promise<AgentResult> {
  const out = await billAgent.invoke({
    billId: input.billId,
    kiranaId: input.kiranaId,
    imagePath: input.imagePath,
    mime: input.mime,
    markupPct: input.markupPct ?? 15,
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
