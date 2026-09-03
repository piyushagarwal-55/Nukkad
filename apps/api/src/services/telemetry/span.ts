import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * WHERE THE TIME WENT, per turn.
 *
 * Built because the honest answer to "why does the voice agent take ten
 * seconds" was a guess. The trace on screen said ear 762ms, think 6492ms,
 * first sound +10151ms -- which locates the problem in "think", a word
 * covering a policy call, a resolver, a composer and somewhere between
 * ten and twenty database round trips to a region 3,000km away. Optimising
 * against that is optimising against a hunch.
 *
 * AsyncLocalStorage rather than a module-level array, because two
 * customers talking at once would otherwise pour their timings into the
 * same bucket and the numbers would silently stop meaning anything. The
 * store is per-turn and follows the async chain into every await.
 *
 * Cheap enough to leave on: one Date.now() per span and a push onto an
 * array. When no turn is in progress -- a script, a cron, a webhook --
 * span() calls through and records nothing, so instrumented functions do
 * not have to care who called them.
 *
 * This is also the skeleton of the event log. A span already knows what
 * happened, in what order, and how long it took; adding what it DECIDED
 * is the part that turns a profile into an audit trail.
 */

export interface Span {
  name: string;
  ms: number;
  /** how deep in the call tree, for indenting the report */
  depth: number;
  /** e.g. "hit" / "miss" on a cache, or the action a policy chose */
  note?: string;
}

interface Turn {
  spans: Span[];
  depth: number;
  startedAt: number;
}

const store = new AsyncLocalStorage<Turn>();

/** run fn as one measured turn, and hand back everything it recorded */
export async function profile<T>(fn: () => Promise<T>): Promise<{ value: T; spans: Span[]; totalMs: number }> {
  const turn: Turn = { spans: [], depth: 0, startedAt: Date.now() };
  const value = await store.run(turn, fn);
  return { value, spans: turn.spans, totalMs: Date.now() - turn.startedAt };
}

export function isProfiling(): boolean {
  return Boolean(store.getStore());
}

export function currentProfile(): { spans: Span[]; totalMs: number } | null {
  const turn = store.getStore();
  if (!turn) return null;
  return { spans: [...turn.spans], totalMs: Date.now() - turn.startedAt };
}

/**
 * Measure one step. Records nothing outside a profile(), which is what
 * lets these sit permanently in the hot path.
 */
export async function span<T>(name: string, fn: () => Promise<T>, note?: (v: T) => string): Promise<T> {
  const turn = store.getStore();
  if (!turn) return fn();

  const depth = turn.depth++;
  const at = Date.now();
  try {
    const v = await fn();
    turn.spans.push({ name, ms: Date.now() - at, depth, note: note?.(v) });
    return v;
  } catch (e) {
    turn.spans.push({ name, ms: Date.now() - at, depth, note: 'threw' });
    throw e;
  } finally {
    turn.depth = depth;
  }
}

/** note something that took no measurable time, e.g. a cache hit */
export function mark(name: string, note?: string): void {
  const turn = store.getStore();
  if (turn) turn.spans.push({ name, ms: 0, depth: turn.depth, note });
}

/**
 * The report, sorted by cost rather than by call order.
 *
 * Call order is how you read a trace and cost order is how you decide
 * what to fix, and the second is what this is for. The tree is printed
 * underneath for context.
 */
export function report(spans: Span[], totalMs: number): string {
  const rolled = new Map<string, { ms: number; n: number; notes: Set<string> }>();
  for (const s of spans) {
    const r = rolled.get(s.name) ?? { ms: 0, n: 0, notes: new Set<string>() };
    r.ms += s.ms;
    r.n++;
    if (s.note) r.notes.add(s.note);
    rolled.set(s.name, r);
  }

  const lines = ['', `TOTAL ${totalMs}ms`, ''];
  lines.push('by cost');
  [...rolled.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .forEach(([name, r]) => {
      const pct = totalMs ? Math.round((r.ms / totalMs) * 100) : 0;
      const notes = r.notes.size ? `  ${[...r.notes].join(',')}` : '';
      lines.push(`  ${String(r.ms).padStart(6)}ms ${String(pct).padStart(3)}%  x${String(r.n).padEnd(3)} ${name}${notes}`);
    });

  lines.push('', 'in order');
  for (const s of spans) {
    lines.push(`  ${'  '.repeat(s.depth)}${String(s.ms).padStart(5)}ms  ${s.name}${s.note ? `  (${s.note})` : ''}`);
  }
  return lines.join('\n');
}
