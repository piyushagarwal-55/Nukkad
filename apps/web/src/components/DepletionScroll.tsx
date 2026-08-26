'use client';

import { useRef } from 'react';
import {
  motion,
  useScroll,
  useSpring,
  useTransform,
  useMotionValueEvent,
  type MotionValue,
} from 'framer-motion';
import { useState } from 'react';

/**
 * Scroll-scrubbed sequence, built on the pattern the reference site uses:
 *
 *   - a section several viewports tall
 *   - a sticky inner window that stays put while you scroll past it
 *   - one scroll-progress value (0 to 1) scrubbing the whole timeline
 *   - different elements reading that SAME value at different rates,
 *     which is what produces the parallax
 *
 * The reference drives two text columns at rates proportional to 45 and
 * 220 wpm. Same mechanism here, except the rates are per-staple burn
 * rates, so scrolling literally means time passing in the household.
 *
 * scrollYProgress is passed through a spring. Raw scroll is jittery on a
 * trackpad and every element inherits that jitter; smoothing once at the
 * source fixes all of them.
 */

interface Staple {
  name: string;
  /** days this lasts. Lower = drains faster = moves more per scroll unit. */
  days: number;
  /** parallax depth for the row itself, 0 = static, 1 = full travel */
  depth: number;
}

const STAPLES: Staple[] = [
  { name: 'Flour', days: 24, depth: 1.0 },
  { name: 'Rice', days: 38, depth: 0.82 },
  { name: 'Lentils', days: 30, depth: 0.9 },
  { name: 'Oil', days: 34, depth: 0.7 },
  { name: 'Sugar', days: 46, depth: 0.55 },
];

/** the whole run covers this many days */
const SPAN = 26;

function StapleRow({
  s,
  progress,
  index,
}: {
  s: Staple;
  progress: MotionValue<number>;
  index: number;
}) {
  // Each bar empties at its own rate. A 24-day staple is fully spent by the
  // time 24 of the 26 days have passed; a 46-day one is barely touched.
  const spent = useTransform(progress, (p) => Math.min(1, (p * SPAN) / s.days));
  const scaleX = useTransform(spent, (v) => Math.max(0.02, 1 - v));

  // Rows drift up at different depths. This is the parallax: one input,
  // different multipliers.
  const y = useTransform(progress, [0, 1], [14 * s.depth, -14 * s.depth]);

  const [low, setLow] = useState(false);
  useMotionValueEvent(spent, 'change', (v) => setLow(v > 0.88));

  return (
    <motion.div style={{ y }} className="w-full">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="display text-xl">{s.name}</span>
        <motion.span
          animate={{ opacity: low ? 1 : 0, x: low ? 0 : -6 }}
          transition={{ duration: 0.3 }}
          className="text-[11px] tracking-widest text-[var(--hot)] uppercase"
        >
          out
        </motion.span>
      </div>
      <div className="h-[3px] w-full rounded-full bg-[var(--ink)]/12">
        <motion.div
          style={{ scaleX, originX: 0 }}
          animate={{ backgroundColor: low ? 'var(--hot)' : 'var(--ink)' }}
          transition={{ duration: 0.35 }}
          className="h-full w-full rounded-full"
        />
      </div>
      <span className="muted mt-1.5 block text-[11px]">
        lasts {s.days} days
      </span>
      <span className="sr-only">{index}</span>
    </motion.div>
  );
}

export function DepletionScroll() {
  const ref = useRef<HTMLElement>(null);

  // start start -> end end is the reference's "top top -> bottom bottom".
  // The sticky child stays pinned for exactly this range.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end end'],
  });

  const p = useSpring(scrollYProgress, {
    stiffness: 80,
    damping: 30,
    mass: 0.4,
  });

  // --- things reading the same progress at different rates ---
  const dayText = useTransform(p, (v) => String(Math.max(1, Math.round(v * SPAN))));
  const headingY = useTransform(p, [0, 1], [18, -18]); // slowest, sits back
  const panelY = useTransform(p, [0, 1], [24, -24]); // mid

  const [day, setDay] = useState('1');
  useMotionValueEvent(dayText, 'change', setDay);

  return (
    <section ref={ref} className="relative h-[380vh]">
      <div className="sticky top-0 flex h-screen items-center overflow-hidden pt-20">
        <div className="mx-auto w-full max-w-6xl px-6">
          <div className="grid items-center gap-16 lg:grid-cols-2">
            {/* ---------- left: the counter ---------- */}
            <motion.div style={{ y: headingY }}>

              <div className="mt-5 flex items-baseline gap-4">
                <span className="display text-[clamp(4rem,12vw,9rem)] tabular-nums">
                  {day}
                </span>
                <span className="display-italic text-3xl text-[var(--muted)]">
                  days
                </span>
              </div>

              <p className="muted mt-6 max-w-sm leading-relaxed">
                One household, twenty-six days. Staples go at a steady rate,
                flour first and sugar last, and the pattern repeats every month.
                Nobody keeps track of it.
              </p>
            </motion.div>

            {/* ---------- right: the staples ---------- */}
            <motion.div style={{ y: panelY }} className="space-y-7">
              {STAPLES.map((s, i) => (
                <StapleRow key={s.name} s={s} progress={p} index={i} />
              ))}
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
}
