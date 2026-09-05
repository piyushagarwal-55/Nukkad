'use client';

import { useRef, type CSSProperties, type ReactNode } from 'react';
import { motion, useScroll, useSpring, useTransform, type MotionValue } from 'framer-motion';

/**
 * A five-panel comic that plays on scroll.
 *
 * One scroll-progress value drives the whole sequence. Each panel owns a
 * slice of it and cross-dissolves with its neighbours. INSIDE a panel,
 * layers read that same slice at different rates, which is what produces
 * the depth:
 *
 *   layer          depth   reads as
 *   -------------------------------------------------
 *   dot screen      0.2    the paper, barely moves
 *   props / rays    0.45   behind the subject
 *   phone or figure 0.7    the subject
 *   bubbles, sfx    1.0    nearest the reader, moves most
 *
 * WHY REAL INTERFACE: an earlier version drew abstract shapes and it
 * demonstrated nothing — a viewer could not tell what the product did.
 * These panels contain an actual chat thread, an actual parsed order with
 * line items and prices, and an actual bill. The story is legible without
 * the captions, which is the test.
 *
 * Everything is CSS and inline SVG. No images, no video, no icon font.
 */

/* ==================================================================== */
/*  PHONE CHROME                                                         */
/* ==================================================================== */

function PhoneShell({
  children,
  time = '9:41',
}: {
  children: ReactNode;
  time?: string;
}) {
  return (
    <div className="ph-shell h-full w-[248px] shrink-0">
      <div className="ph-screen h-full">
        <span className="ph-notch" />
        <div className="ph-status">
          <span>{time}</span>
          <span className="flex items-center gap-[3px]">
            <Signal />
            <Wifi />
            <Battery />
          </span>
        </div>
        {children}
        <span className="ph-home" />
      </div>
    </div>
  );
}

function Signal() {
  return (
    <svg width="11" height="8" viewBox="0 0 11 8" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={i * 3}
          y={7 - (i + 1) * 1.7}
          width="2"
          height={(i + 1) * 1.7}
          rx="0.5"
          fill="#1a1a1a"
        />
      ))}
    </svg>
  );
}

function Wifi() {
  return (
    <svg width="10" height="8" viewBox="0 0 10 8" aria-hidden>
      <path d="M1 3a6 6 0 018 0" stroke="#1a1a1a" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <path d="M2.8 5a3.4 3.4 0 014.4 0" stroke="#1a1a1a" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <circle cx="5" cy="6.8" r="0.9" fill="#1a1a1a" />
    </svg>
  );
}

function Battery() {
  return (
    <svg width="15" height="8" viewBox="0 0 15 8" aria-hidden>
      <rect x="0.5" y="0.5" width="12" height="7" rx="2" stroke="#1a1a1a" strokeWidth="1" fill="none" />
      <rect x="2" y="2" width="8" height="4" rx="1" fill="#1a1a1a" />
      <rect x="13.2" y="2.6" width="1.6" height="2.8" rx="0.6" fill="#1a1a1a" />
    </svg>
  );
}

/** Chat header: back chevron, avatar, contact name, call icons. */
function ChatHeader({ name, initial }: { name: string; initial: string }) {
  return (
    <div className="ph-bar">
      <span className="text-[11px] leading-none text-[#1a1a1a99]">&#8249;</span>
      <span className="grid h-[18px] w-[18px] place-items-center rounded-full bg-[#c9bda9] text-[8px] font-bold text-[#1a1a1a]">
        {initial}
      </span>
      <span className="flex-1 text-[9.5px] font-semibold">{name}</span>
      <svg width="12" height="9" viewBox="0 0 12 9" aria-hidden>
        <rect x="0.5" y="0.5" width="7.5" height="8" rx="1.6" stroke="#1a1a1a99" strokeWidth="1" fill="none" />
        <path d="M8.6 3.2L11.5 1.5v6L8.6 5.8z" fill="#1a1a1a99" />
      </svg>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path
          d="M1.2 1.6c0-.5.4-.9.9-.9h1c.4 0 .8.3.9.7l.4 1.6c.1.4-.1.8-.4 1l-.7.5c.6 1.2 1.5 2.1 2.7 2.7l.5-.7c.2-.3.6-.5 1-.4l1.6.4c.4.1.7.5.7.9v1c0 .5-.4.9-.9.9C4.6 9.3.7 5.4 1.2 1.6z"
          fill="#1a1a1a99"
        />
      </svg>
    </div>
  );
}

/* ==================================================================== */
/*  MESSAGES                                                             */
/* ==================================================================== */

function Msg({
  side = 'in',
  time,
  read,
  children,
  className = '',
}: {
  side?: 'in' | 'out';
  time: string;
  read?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`msg ${side === 'in' ? 'msg-in' : 'msg-out'} ${className}`}>
      {children}
      <div className="msg-meta">
        <span>{time}</span>
        {side === 'out' && <span className={read ? 'msg-tick' : ''}>&#10003;&#10003;</span>}
      </div>
    </div>
  );
}


/* ==================================================================== */
/*  SCREENS                                                              */
/*                                                                       */
/*  The product is a VOICE agent. It works out that a household is about */
/*  to run out, phones them, takes the order by speech, confirms on the  */
/*  call, and only then sends the bill to WhatsApp to be paid.           */
/*                                                                       */
/*  WhatsApp is the LAST panel, not the story. An earlier version led    */
/*  with a chat thread and it made the whole thing look like a messaging */
/*  app, which is the one thing it is not.                               */
/* ==================================================================== */

/** Panel 1 — the agent works it out on its own. No one asked. */
const STOCK = [
  { name: 'Flour', days: 2, fill: 0.09, low: true },
  { name: 'Cooking oil', days: 4, fill: 0.2, low: true },
  { name: 'Sugar', days: 11, fill: 0.46 },
  { name: 'Rice', days: 16, fill: 0.68 },
];

function ScreenPrediction() {
  return (
    <>
      <div className="ag-head">
        <span className="ag-dot" />
        <span className="flex-1 text-[9.5px] font-bold">Nukkad agent</span>
        <span className="text-[7.5px] text-[#1a1a1a80]">live</span>
      </div>

      <div className="ag-body flex-1">
        <p className="text-[8px] font-bold tracking-[0.09em] text-[#1a1a1a80] uppercase">
          Sharma household &#183; 4 people
        </p>

        {STOCK.map((it) => (
          <div key={it.name} className="ag-row">
            <span className="ag-label">
              <span>{it.name}</span>
              <span className={'ag-days ' + (it.low ? 'text-[#ff6c4c]' : '')}>
                {it.days} days left
              </span>
            </span>
            <span className="ag-bar">
              <span
                className={'ag-fill block ' + (it.low ? 'ag-fill-low' : '')}
                style={{ width: `${it.fill * 100}%` }}
              />
            </span>
          </div>
        ))}

        <p className="ag-verdict">
          Two items run out this week.
          <br />
          <b>Placing a call to confirm the order.</b>
        </p>
      </div>
      <div className="tech-strip">Predicted from 11 past orders</div>
    </>
  );
}

/** Panel 2 — it dials, unprompted. */
function ScreenIncomingCall() {
  return (
    <div className="flex flex-1 flex-col justify-between px-3 pt-7 pb-3">
      <div className="text-center">
        <div className="call-avatar">
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            {[3, 7, 11, 15, 19, 23].map((x, i) => {
              const h = [7, 14, 20, 12, 17, 8][i];
              return (
                <rect key={x} x={x - 1.4} y={(20 - h) / 2} width="2.8" height={h} rx="1.4" fill="#1a1a1a" />
              );
            })}
          </svg>
        </div>
        <p className="mt-2.5 text-[12px] font-bold">Nukkad</p>
        <p className="text-[8.5px] text-[#1a1a1a99]">Incoming call</p>
        <span className="mt-2 inline-block rounded-full border border-[#1a1a1a30] px-2 py-[2px] text-[7.5px] font-semibold text-[#1a1a1a99]">
          Sharma Kirana Store
        </span>
      </div>
      <div className="flex items-center justify-center gap-8">
        <span className="call-btn bg-[#c0392b]">&#10006;</span>
        <span className="call-btn bg-[#034f46]">&#10004;</span>
      </div>
    </div>
  );
}

/** Panel 3 — the actual conversation, as a live transcript. */
const WAVE = [6, 13, 22, 10, 18, 25, 14, 8, 17, 23, 11, 19, 7, 15, 21, 9];

function ScreenLiveCall() {
  return (
    <div className="flex flex-1 flex-col px-3 pt-6 pb-2">
      <div className="text-center">
        <div className="call-avatar" style={{ width: 44, height: 44 }}>
          <svg width="20" height="15" viewBox="0 0 26 20" aria-hidden>
            {[3, 9, 15, 21].map((x, i) => {
              const h = [9, 18, 13, 16][i];
              return <rect key={x} x={x - 1.4} y={(20 - h) / 2} width="2.8" height={h} rx="1.4" fill="#1a1a1a" />;
            })}
          </svg>
        </div>
        <p className="mt-1.5 text-[10px] font-bold">Nukkad</p>
        <p className="text-[8px] tabular-nums text-[#1a1a1a99]">0:14</p>
      </div>

      <div className="call-wave my-2">
        {WAVE.map((h, i) => (
          <span key={i} style={{ height: h }} />
        ))}
      </div>

      <div className="flex flex-col gap-2.5">
        <div>
          <span className="turn-tag turn-agent">Agent</span>
          <p className="tx tx-agent mt-1">
            Your flour and oil run out in two days. Send the usual?
          </p>
        </div>
        <div>
          <span className="turn-tag turn-user">Customer</span>
          <p className="tx tx-user mt-1">Haan bhej do. Aur chai bhi daal dena.</p>
        </div>
      </div>

      <div className="tech-strip mt-auto">Speech by Deepgram</div>
    </div>
  );
}

/** Panel 4 — confirmed on the call, before anything is sent. */
function ScreenCallConfirmed() {
  return (
    <div className="flex flex-1 flex-col px-3 pt-6 pb-2">
      <div className="text-center">
        <div className="call-avatar" style={{ width: 44, height: 44 }}>
          <span className="text-[15px]">&#10004;</span>
        </div>
        <p className="mt-1.5 text-[10px] font-bold">Order confirmed</p>
        <p className="text-[8px] tabular-nums text-[#1a1a1a99]">on call &#183; 0:31</p>
      </div>

      <div className="mt-3 flex flex-col gap-0.5">
        <div className="tick-row"><span className="tick-mark">&#10003;</span>Aashirvaad Atta 5kg</div>
        <div className="tick-row"><span className="tick-mark">&#10003;</span>Fortune Oil 1L</div>
        <div className="tick-row">
          <span className="tick-mark tick-added">+</span>Tata Tea Gold 500g
        </div>
      </div>

      <p className="mt-3 border-t border-dashed border-[#1a1a1a33] pt-2.5 text-[9px] leading-relaxed">
        Sending your bill and payment link on WhatsApp.
      </p>
      <div className="tech-strip mt-auto">No app. No typing.</div>
    </div>
  );
}

/** Panel 5 — and only now, WhatsApp. */
const ORDER = [
  ['Aashirvaad Atta 5kg', 'Rs 285'],
  ['Fortune Sunflower Oil 1L', 'Rs 155'],
  ['Tata Tea Gold 500g', 'Rs 305'],
];

function OrderCard({ total = 'Rs 745' }: { total?: string }) {
  return (
    <div>
      {ORDER.map(([name, price]) => (
        <div key={name} className="ord-row">
          <span className="truncate">{name}</span>
          <span className="shrink-0 tabular-nums">{price}</span>
        </div>
      ))}
      <div className="ord-rule" />
      <div className="ord-row ord-total">
        <span>Total</span>
        <span className="tabular-nums">{total}</span>
      </div>
    </div>
  );
}

function ScreenBillPaid() {
  return (
    <>
      <ChatHeader name="Sharma Kirana Store" initial="S" />
      <div className="ph-chat halftone">
        <Msg side="in" time="9:03 am">
          <p className="text-[8px] font-bold tracking-wide text-[#1a1a1a99]">BILL &#183; #4471</p>
          <div className="mt-1">
            <OrderCard />
          </div>
          <div className="pay-btn mt-2">Pay Rs 745</div>
          <p className="mt-1 text-center text-[7.5px] text-[#1a1a1a80]">Secured by Razorpay</p>
        </Msg>
        <Msg side="out" time="9:04 am" read>
          <p>Paid</p>
        </Msg>
      </div>
    </>
  );
}

/* ==================================================================== */
/*  PANEL MACHINERY                                                      */
/* ==================================================================== */

const PANEL_COUNT = 5;
const HOLD = 1 / PANEL_COUNT;

function usePanelWindow(progress: MotionValue<number>, index: number) {
  const start = index * HOLD;
  const end = start + HOLD;
  const fade = HOLD * 0.11;

  // Reaches full opacity well inside its own slice and leaves it late, so
  // there is a long flat middle where the panel is simply ON.
  const opacity = useTransform(
    progress,
    [start - fade, start + fade * 0.35, end - fade * 0.35, end + fade],
    [index === 0 ? 1 : 0, 1, 1, index === PANEL_COUNT - 1 ? 1 : 0],
  );
  const local = useTransform(progress, [start - fade, end + fade], [0, 1]);
  return { opacity, local };
}

function Layer({
  local,
  depth,
  className = '',
  children,
}: {
  local: MotionValue<number>;
  depth: number;
  className?: string;
  children: ReactNode;
}) {
  const y = useTransform(local, [0, 1], [34 * depth, -34 * depth]);
  const x = useTransform(local, [0, 1], [10 * depth, -10 * depth]);
  return (
    <motion.div style={{ y, x }} className={className}>
      {children}
    </motion.div>
  );
}

interface PanelDef {
  caption: string;
  wash: string;
  dot: string;
  dotGap: string;
  art: ReactNode;
  bubble?: string;
  thought?: boolean;
  sfx?: string;
  sfxBg?: string;
  rays?: boolean;
  stamp?: string;
}

const PANELS: PanelDef[] = [
  {
    caption: 'Nobody asked it to check',
    wash: '#f3ecdd',
    dot: '#1a1a1a1c',
    dotGap: '13px',
    art: (
      <PhoneShell time="8:58">
        <ScreenPrediction />
      </PhoneShell>
    ),
    bubble: 'It already knows the flour runs out on Thursday.',
  },
  {
    caption: 'So it calls',
    wash: '#f6efff',
    dot: '#f0d7ff66',
    dotGap: '14px',
    art: (
      <PhoneShell time="9:01">
        <ScreenIncomingCall />
      </PhoneShell>
    ),
    bubble: 'No app to open. The phone simply rings.',
    sfx: 'Ring',
    sfxBg: 'var(--accent)',
    rays: true,
  },
  {
    caption: 'And it talks',
    wash: '#f1efe4',
    dot: '#1a1a1a1c',
    dotGap: '13px',
    art: (
      <PhoneShell time="9:01">
        <ScreenLiveCall />
      </PhoneShell>
    ),
    bubble: 'Answer in Hindi, English, or half of each. It keeps up.',
    sfx: 'Beep',
    sfxBg: 'var(--amber)',
  },
  {
    caption: 'Confirmed before you hang up',
    wash: '#ffeae3',
    dot: '#ff6c4c2b',
    dotGap: '12px',
    art: (
      <PhoneShell time="9:02">
        <ScreenCallConfirmed />
      </PhoneShell>
    ),
    bubble: 'Thirty-one seconds, and the order is placed.',
  },
  {
    caption: 'Then the bill arrives',
    wash: '#e9f2ee',
    dot: '#034f4626',
    dotGap: '13px',
    art: (
      <PhoneShell time="9:03">
        <ScreenBillPaid />
      </PhoneShell>
    ),
    bubble: 'Bill and payment link on WhatsApp. Tap once to pay.',
    stamp: 'Paid',
  },
];

function Panel({
  def,
  index,
  progress,
}: {
  def: PanelDef;
  index: number;
  progress: MotionValue<number>;
}) {
  const { opacity, local } = usePanelWindow(progress, index);

  /* ---------------------------------------------------------------- */
  /*  ENTRANCE                                                         */
  /*                                                                   */
  /*  A cross-fade on its own was invisible — panels swapped and you    */
  /*  could not tell it had happened. Each panel now DEALS IN like a    */
  /*  card: it arrives from the right, slightly rotated and small,      */
  /*  squares up, holds flat through the middle, then leaves to the     */
  /*  left with the opposite tilt.                                     */
  /*                                                                   */
  /*  Then the contents land in order, not together:                    */
  /*      frame  -> caption -> bubble -> burst                          */
  /*  Staggering is what makes the change register. Everything moving   */
  /*  at once reads as one blurry shove.                                */
  /* ---------------------------------------------------------------- */
  const IN = 0.15;
  const OUT = 0.85;

  const x = useTransform(local, [0, IN, OUT, 1], [110, 0, 0, -110]);
  const rotate = useTransform(local, [0, IN, OUT, 1], [4.5, 0, 0, -4.5]);
  const scale = useTransform(local, [0, IN, OUT, 1], [0.9, 1, 1, 0.9]);

  // caption slides in from the left edge, just after the frame settles
  const capX = useTransform(local, [0.1, 0.26], [-46, 0]);
  const capO = useTransform(local, [0.1, 0.24], [0, 1]);

  // bubble pops, slightly overshooting on the way in
  const bubScale = useTransform(local, [0.18, 0.3, 0.38], [0.72, 1.04, 1]);
  const bubO = useTransform(local, [0.18, 0.28], [0, 1]);

  // burst spins in last, the loudest thing on the page
  const sfxScale = useTransform(local, [0.26, 0.4], [0, 1]);
  const sfxRot = useTransform(local, [0.26, 0.4], [-40, 0]);

  const rayspin = useTransform(local, [0, 1], [0, 22]);

  return (
    <motion.div style={{ opacity }} className="absolute inset-0 grid place-items-center">
      <motion.div
        style={{
          x,
          rotate,
          scale,
          background: def.wash,
          // Only the custom properties need the cast. Casting the whole
          // object widens the motion values into plain CSS types and
          // Framer stops driving them.
          ...({ '--dot': def.dot, '--dot-gap': def.dotGap } as CSSProperties),
        }}
        className="comic-frame relative h-[72vh] max-h-[620px] w-full overflow-hidden"
      >
        {/* depth 0.2 — the paper */}
        <Layer local={local} depth={0.2} className="absolute -inset-10">
          <div className="halftone h-full w-full" />
        </Layer>

        {/* depth 0.45 — behind the subject */}
        {def.rays && (
          <Layer local={local} depth={0.45} className="absolute inset-0 grid place-items-center">
            <motion.span
              style={{ rotate: rayspin }}
              className="comic-rays block h-[130%] w-[130%] opacity-20"
            />
          </Layer>
        )}

        {/* TEXT LEFT, ART RIGHT. Two columns so the caption, the bubble and
            the phone each get their own space instead of stacking on top of
            one another. */}
        <div className="relative z-10 grid h-full grid-cols-[1fr_auto] items-center gap-6 px-8 py-7 sm:gap-10 sm:px-11">
          <Layer local={local} depth={0.85} className="flex flex-col items-start gap-6">
            <motion.span
              style={{ x: capX, opacity: capO }}
              className="comic-caption px-3 py-[7px]"
            >
              {def.caption}
            </motion.span>

            {def.bubble && (
              <motion.span
                style={{ scale: bubScale, opacity: bubO, originX: 0.15, originY: 0.9 }}
                className={
                  'comic-bubble relative px-6 py-4 text-[17px] leading-snug sm:text-[19px] ' +
                  (def.thought ? 'comic-thought' : '')
                }
              >
                {def.bubble}
                {def.thought && <span className="comic-thought-dot" />}
              </motion.span>
            )}

            <span className="flex items-center gap-4">
              {def.sfx && (
                <motion.span
                  style={{ scale: sfxScale, rotate: sfxRot, background: def.sfxBg }}
                  className="comic-burst h-[86px] w-[86px] text-[16px] text-[var(--ink)]"
                >
                  {def.sfx}
                </motion.span>
              )}
              {def.stamp && (
                <motion.span
                  style={{ scale: sfxScale, rotate: sfxRot, color: 'var(--green)' }}
                  className="comic-stamp px-5 py-2.5 text-[16px]"
                >
                  {def.stamp}
                </motion.span>
              )}
            </span>
          </Layer>

          {/* depth 0.7 — the subject */}
          <Layer local={local} depth={0.7} className="h-full py-1">
            {def.art}
          </Layer>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ==================================================================== */
/*  SECTION                                                              */
/* ==================================================================== */

export function ComicScroll() {
  const ref = useRef<HTMLElement>(null);

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end end'],
  });
  // Keep enough damping for trackpads, but avoid compressing panel changes
  // into one fast flick.
  const p = useSpring(scrollYProgress, { stiffness: 74, damping: 38, mass: 0.5 });
  const railScale = useTransform(p, [0, 1], [0.02, 1]);

  return (
    <section ref={ref} className="relative h-[820vh]">
      <div className="sticky top-0 flex h-screen flex-col justify-center overflow-hidden pt-20 pb-10">
        <div className="relative mx-auto h-[76vh] w-full max-w-5xl px-6">
          {PANELS.map((d, i) => (
            <Panel key={d.caption} def={d} index={i} progress={p} />
          ))}
        </div>

        {/* how far through the sequence you are */}
        <div className="mx-auto mt-6 w-full max-w-5xl px-6">
          <div className="comic-rail">
            <motion.div style={{ scaleX: railScale }} className="comic-rail-fill" />
          </div>
        </div>
      </div>
    </section>
  );
}
