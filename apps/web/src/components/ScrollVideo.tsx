'use client';

import { useRef } from 'react';
import { motion, useScroll, useSpring, useTransform, type MotionValue } from 'framer-motion';

/**
 * ONE video, THREE phases, driven by a single scroll-progress value.
 *
 *   0.00 - 0.12   the video sits centre and settles to full size
 *   0.12 - 0.30   it slides LEFT
 *   0.18 - 0.46     ... and the PROBLEM reveals on the RIGHT, block by block
 *   0.46 - 0.52   the problem column clears out
 *   0.50 - 0.68   the same video travels DIAGONALLY DOWN-RIGHT, crossing
 *                 through centre on the way
 *   0.58 - 0.92     ... and the SOLUTION reveals on the LEFT, block by block
 *
 * WHY THE PROBLEM COLUMN FADES: the video crosses the right half on its way
 * down-right. If the problem text were still there it would be driven over.
 * It clears between 0.46 and 0.52, just before the video starts moving.
 *
 * WHY ONE ELEMENT: an earlier version split this across two sections, each
 * mounting its own <video>. That put two copies of the same clip on the
 * page, looping independently and out of step with each other and with the
 * text. One element cannot disagree with itself.
 *
 * LAYOUT NOTE: centring lives on the outer div as plain CSS and the
 * animation on the inner motion.div. Framer's `x` IS translateX, so the two
 * would fight if both sat on one element.
 */

const PROBLEM = [
  {
    h: 'A list arrives from home.',
    p: 'Sometimes written on paper, sometimes sent on WhatsApp. Almost the same items every month.',
  },
  {
    h: 'Then you have to remember it.',
    p: 'Two days later, on the way to the shop, that list has to be in your head. Or found again in your phone.',
  },
  {
    h: 'And you do not remember it.',
    p: 'The flour got missed. Something always gets missed, and it is gone before the next trip.',
  },
  {
    h: 'This is not your fault.',
    p: 'Remembering should not be a person’s job. Keeping count is what a machine is for.',
  },
];

const SOLUTION = [
  {
    h: 'Forward the same photo.',
    p: 'Nothing gets retyped. The list that already arrived from home goes straight to the shop.',
  },
  {
    h: 'The shop reads it.',
    p: 'Every line is matched against that shop’s own catalogue, using what this household actually buys.',
  },
  {
    h: 'One card to approve.',
    p: 'Stock checked, substitutes settled, then a single message. Confirm, or change it.',
  },
  {
    h: 'Paid and delivered.',
    p: 'A payment link for what is owed, and the ledger updates itself. Nobody had to remember anything.',
  },
];

/* ---- phase boundaries, all in one place so the timing stays legible ---- */
const CENTRE_END = 0.12;
const LEFT_END = 0.3;
const PROBLEM_IN = 0.18;
const PROBLEM_OUT = 0.46;
const DIAG_START = 0.5;
const DIAG_END = 0.68;
const SOLUTION_IN = 0.58;

function Block({
  block,
  start,
  progress,
}: {
  block: { h: string; p: string };
  start: number;
  progress: MotionValue<number>;
}) {
  const opacity = useTransform(progress, [start, start + 0.06], [0, 1]);
  const y = useTransform(progress, [start, start + 0.06], [24, 0]);

  // Sized so FOUR of these plus an eyebrow clear a short viewport. At
  // text-3xl with space-y-9 the column ran past the sticky window and the
  // first block disappeared under the nav.
  return (
    <motion.div style={{ opacity, y }} className="border-l-2 border-[var(--line)] pl-4">
      <h3 className="display text-xl sm:text-2xl">{block.h}</h3>
      <p className="muted mt-1.5 text-sm leading-relaxed sm:text-base">{block.p}</p>
    </motion.div>
  );
}

export function ScrollVideo() {
  const ref = useRef<HTMLElement>(null);

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end end'],
  });

  // Smooth once at the source. Raw scroll is jittery on a trackpad and every
  // derived value inherits that jitter.
  const p = useSpring(scrollYProgress, { stiffness: 90, damping: 30, mass: 0.35 });

  /* ---------------- the video: centre -> left -> down-right -------------- */
  const x = useTransform(
    p,
    [0, CENTRE_END, LEFT_END, DIAG_START, DIAG_END],
    [0, 0, -300, -300, 330],
  );
  // y only moves on the diagonal leg, which is what makes it a diagonal
  const y = useTransform(p, [DIAG_START, DIAG_END], [0, 64]);
  // Ends at the SAME 1.0 it holds on the left. Easing down to 0.92 here made
  // the right-hand position read as a different, smaller shot.
  const scale = useTransform(
    p,
    [0, CENTRE_END, LEFT_END, DIAG_END],
    [0.9, 1.12, 1.0, 1.0],
  );

  /* ---------------- problem column, RIGHT, phase two --------------------- */
  const problemOpacity = useTransform(
    p,
    [PROBLEM_IN, PROBLEM_IN + 0.05, PROBLEM_OUT, PROBLEM_OUT + 0.06],
    [0, 1, 1, 0],
  );
  const problemX = useTransform(p, [PROBLEM_IN, LEFT_END], [40, 0]);

  /* ---------------- solution column, LEFT, phase three ------------------- */
  const solutionOpacity = useTransform(p, [SOLUTION_IN, SOLUTION_IN + 0.05], [0, 1]);
  const solutionX = useTransform(p, [SOLUTION_IN, DIAG_END], [-40, 0]);

  return (
    <section ref={ref} className="relative h-[520vh]">
      <div className="sticky top-0 flex h-screen items-center overflow-hidden">
        <div className="relative mx-auto w-full max-w-6xl px-6">
          {/* ---------- the one video ---------- */}
          <div className="pointer-events-none absolute top-1/2 left-1/2 hidden -translate-x-1/2 -translate-y-1/2 lg:block">
            <motion.div
              style={{ scale, x, y }}
              className="overflow-hidden rounded-[34px] border border-[var(--ink)] bg-[var(--ink)] shadow-[0_2px_8px_rgba(26,26,26,0.08)]"
            >
              <video
                src="/view1.mp4"
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                className="block h-[68vh] w-auto object-cover"
              />
            </motion.div>
          </div>

          {/* ---------- PROBLEM, on the RIGHT ---------- */}
          <motion.div
            style={{ opacity: problemOpacity, x: problemX }}
            className="ml-auto hidden w-[44%] space-y-5 lg:block"
          >
            {PROBLEM.map((b, i) => (
              <Block key={b.h} block={b} start={PROBLEM_IN + 0.02 + i * 0.06} progress={p} />
            ))}
          </motion.div>

          {/* ---------- SOLUTION, on the LEFT. Absolute so it shares the
                        same row as the problem column instead of pushing
                        the sticky window taller. ---------- */}
          <motion.div
            style={{ opacity: solutionOpacity, x: solutionX }}
            className="absolute inset-y-0 left-6 hidden w-[44%] flex-col justify-center space-y-5 pt-28 pb-10 lg:flex"
          >
            <span className="flex items-center gap-4">
              <span className="h-px w-10 bg-[var(--line-2)]" />
              <span className="display-italic text-xl text-[var(--muted)]">so</span>
              <span className="h-px flex-1 bg-[var(--line)]" />
            </span>
            {SOLUTION.map((b, i) => (
              <Block key={b.h} block={b} start={SOLUTION_IN + 0.02 + i * 0.07} progress={p} />
            ))}
          </motion.div>

          {/* ---------- below lg: no scrub, just stack it ---------- */}
          <div className="lg:hidden">
            <video
              src="/view1.mp4"
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              className="mx-auto block w-full max-w-sm rounded-2xl border border-[var(--ink)]"
            />
            <div className="mt-10 space-y-8">
                {PROBLEM.map((b) => (
                <div key={b.h} className="border-l-2 border-[var(--line)] pl-5">
                  <h3 className="display text-2xl">{b.h}</h3>
                  <p className="muted mt-2 leading-relaxed">{b.p}</p>
                </div>
              ))}
              <span className="flex items-center gap-4 pt-4">
                <span className="h-px w-10 bg-[var(--line-2)]" />
                <span className="display-italic text-xl text-[var(--muted)]">so</span>
                <span className="h-px flex-1 bg-[var(--line)]" />
              </span>
              {SOLUTION.map((b) => (
                <div key={b.h} className="border-l-2 border-[var(--line)] pl-5">
                  <h3 className="display text-2xl">{b.h}</h3>
                  <p className="muted mt-2 leading-relaxed">{b.p}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
