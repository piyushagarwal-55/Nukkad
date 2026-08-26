import Link from 'next/link';
import { Reveal } from '@/components/Reveal';
import { VoiceMark } from '@/components/VoiceMark';
import { HeroFlow, VoicePill } from '@/components/HeroFlow';
import { DepletionScroll } from '@/components/DepletionScroll';
import { ComicScroll } from '@/components/ComicScroll';
import { ScrollVideo } from '@/components/ScrollVideo';

/* ---------------------------------------------------------------------
   Image placeholders. Deliberately visible and labelled so nobody ships
   the page thinking a blank area is a layout bug. Swap each for a real
   asset when the screenshots arrive; the aspect ratios are already the
   ones the layout expects.
   --------------------------------------------------------------------- */
function ImageSlot({
  label,
  ratio = '4 / 3',
  className = '',
}: {
  label: string;
  ratio?: string;
  className?: string;
}) {
  return (
    <div
      style={{ aspectRatio: ratio }}
      className={`flex items-center justify-center rounded-2xl border border-dashed border-[var(--line-2)] bg-[var(--sand)]/50 ${className}`}
    >
      <span className="eyebrow px-4 text-center">{label}</span>
    </div>
  );
}

const SAID = [
  'bhaiya do kilo atta bhej dena',
  'wo peela wala tel',
  'arhar aur ek kilo shakkar',
  'atta khatam ho gaya',
  'tata wali chai',
  'sabun aur manjan',
  'dedh kilo chawal',
  'wahi wala jo hamesha lete hain',
];

const FAQ = [
  {
    q: 'Does the customer need to download an app?',
    a: 'No. Only WhatsApp. They scan the QR on your counter once and that is it. No app, no password, no signup form.',
  },
  {
    q: 'What if it gets the order wrong?',
    a: 'The customer sees it before it is placed. Where the system is unsure it offers two or three options and the customer taps one. Every tap makes the catalogue better.',
  },
  {
    q: 'How long does it take to build my catalogue?',
    a: 'Five minutes. Upload a supplier bill and the items, quantities and rates fill themselves. Typing four hundred items by hand would take two hours, so we do not ask you to.',
  },
  {
    q: 'What happens when something is out of stock?',
    a: 'The system checks stock first, picks a substitute, and only then sends the confirmation card. The customer is asked once, not twice.',
  },
  {
    q: 'How does payment work?',
    a: 'Households can pay cash or direct UPI exactly as they do today, at no charge. The Razorpay link belongs where credit exists, on the distributor bill, where paying half now and half later is normal.',
  },
];

/* ---------------------------------------------------------------------
   Accuracy icons. Flat blocks, thick strokes, one accent each — built to
   be read at a glance from across a room, not studied.
   --------------------------------------------------------------------- */

function IconAudioOnly() {
  return (
    <svg viewBox="0 0 132 112" className="h-full w-full" aria-hidden>
      <rect x="14" y="26" width="88" height="60" rx="16" fill="var(--amber)" />
      {[30, 44, 58, 72, 86].map((x, i) => {
        const h = [16, 30, 40, 24, 12][i];
        return (
          <rect key={x} x={x} y={56 - h / 2} width="7" height={h} rx="3.5" fill="var(--ink)" />
        );
      })}
      {/* the miss */}
      <circle cx="100" cy="80" r="21" fill="var(--hot)" stroke="var(--ink)" strokeWidth="3.5" />
      <path
        d="M92 72l16 16M108 72l-16 16"
        stroke="var(--ink)"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconCatalogue() {
  return (
    <svg viewBox="0 0 132 112" className="h-full w-full" aria-hidden>
      <rect x="16" y="18" width="82" height="76" rx="14" fill="var(--accent)" stroke="var(--ink)" strokeWidth="3.5" />
      {[34, 50, 66, 82].map((y) => (
        <g key={y}>
          <rect x="28" y={y - 5} width="10" height="10" rx="3" fill="var(--ink)" />
          <rect x="44" y={y - 3} width={y === 66 ? 28 : 40} height="6" rx="3" fill="var(--ink)" opacity="0.5" />
        </g>
      ))}
      {/* the pick */}
      <circle cx="98" cy="74" r="20" fill="var(--bg)" stroke="var(--ink)" strokeWidth="3.5" />
      <circle cx="96" cy="72" r="8" fill="none" stroke="var(--ink)" strokeWidth="3.5" />
      <path d="M102 78l7 7" stroke="var(--ink)" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

function IconHistory() {
  return (
    <svg viewBox="0 0 132 112" className="h-full w-full" aria-hidden>
      <rect x="18" y="20" width="76" height="72" rx="16" fill="var(--pink)" />
      {/* repeat arrow: they buy the same things every month */}
      <path
        d="M40 60a16 16 0 1116 16"
        fill="none"
        stroke="var(--ink)"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path d="M34 52l6 9 10-5" fill="none" stroke="var(--ink)" strokeWidth="5"
            strokeLinecap="round" strokeLinejoin="round" />
      {/* the hit */}
      <circle cx="98" cy="76" r="21" fill="var(--green)" stroke="var(--ink)" strokeWidth="3.5" />
      <path d="M89 76l7 8 12-15" fill="none" stroke="var(--bg)" strokeWidth="4.5"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


/* ---------------------------------------------------------------------
   The supplier bill on the left, the catalogue filling on the right.
   Pure CSS animation on one shared 5.6s cycle, so nothing needs scroll
   position or JavaScript to stay in step.
   --------------------------------------------------------------------- */

const BILL_LINES = [
  ['Aashirvaad Atta 5kg', '12', '255.00'],
  ['Fortune Sunflower Oil 1L', '24', '140.00'],
  ['Tata Salt 1kg', '30', '24.00'],
  ['India Gate Basmati 5kg', '8', '480.00'],
  ['Tata Tea Gold 500g', '10', '270.00'],
];

const CATALOGUE_ROWS = [
  { name: 'Aashirvaad Atta 5kg', price: 'Rs 285', chips: ['atta', 'aata', 'gehu ka atta'] },
  { name: 'Fortune Sunflower Oil 1L', price: 'Rs 155', chips: ['tel', 'peela wala tel'] },
  { name: 'Tata Salt 1kg', price: 'Rs 28', chips: ['namak'] },
  { name: 'India Gate Basmati 5kg', price: 'Rs 540', chips: ['chawal', 'basmati'] },
  { name: 'Tata Tea Gold 500g', price: 'Rs 305', chips: ['chai', 'chai patti'] },
];

function BillToCatalogue() {
  return (
    <div className="grid grid-cols-[1fr_auto_1.15fr] items-center gap-3 sm:gap-4">
      {/* ---------------- the supplier bill ---------------- */}
      <div className="b2c-paper p-3">
        <p className="text-[8px] font-bold tracking-[0.12em] text-[var(--muted)] uppercase">
          Shree Balaji Traders
        </p>
        <p className="mt-0.5 text-[8px] text-[var(--muted)]">Bill 4471 &middot; 24 Aug</p>

        <div className="mt-2.5 space-y-[3px]">
          {BILL_LINES.map(([name, qty, rate], i) => (
            <div
              key={name}
              className="b2c-line flex items-baseline gap-1.5 px-1 py-[3px] text-[8px]"
              style={{ animationDelay: `${i * 0.16}s` }}
            >
              <span className="flex-1 truncate">{name}</span>
              <span className="tabular-nums text-[var(--muted)]">{qty}</span>
              <span className="w-9 text-right tabular-nums">{rate}</span>
            </div>
          ))}
        </div>
        <span className="b2c-scan" />
      </div>

      {/* ---------------- the hand-off ---------------- */}
      <span className="b2c-arrow grid h-8 w-8 place-items-center rounded-full border-[2.5px] border-[var(--ink)] bg-[var(--amber)] text-sm font-bold sm:h-10 sm:w-10 sm:text-base">
        &rarr;
      </span>

      {/* ---------------- the catalogue ---------------- */}
      <div className="b2c-paper p-3">
        <p className="text-[8px] font-bold tracking-[0.12em] text-[var(--muted)] uppercase">
          Your catalogue
        </p>

        <div className="mt-2.5 space-y-2">
          {CATALOGUE_ROWS.map((r, i) => (
            <div
              key={r.name}
              className="b2c-row"
              style={{ animationDelay: `${i * 0.16}s` }}
            >
              <div className="flex items-baseline gap-1.5">
                <span
                  className="b2c-tick grid h-3 w-3 shrink-0 place-items-center rounded-full bg-[var(--green)] text-[7px] text-[var(--bg)]"
                  style={{ animationDelay: `${i * 0.16}s` }}
                >
                  &#10003;
                </span>
                <span className="flex-1 truncate text-[8.5px] font-medium">{r.name}</span>
                <span className="text-[8px] tabular-nums text-[var(--muted)]">{r.price}</span>
              </div>
              <div className="mt-1 ml-4 flex flex-wrap gap-1">
                {r.chips.map((c, j) => (
                  <span
                    key={c}
                    className="b2c-chip rounded-full bg-[var(--accent)] px-1.5 py-[1px] text-[7px] font-medium"
                    style={{ animationDelay: `${i * 0.16 + j * 0.07}s` }}
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


/* ---------------------------------------------------------------------
   Dot field for the closing section. One dot per shop, near enough.

   The lit ones are picked by a fixed rule rather than Math.random, so the
   server and the client render the same field and hydration stays quiet.
   --------------------------------------------------------------------- */
const CLOSER_DOTS = Array.from({ length: 260 }, (_, i) => ({
  i,
  live: i % 17 === 3 || i % 23 === 7,
  delay: ((i * 37) % 90) / 10,
}));

function ShopField() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex flex-wrap content-center justify-center gap-x-6 gap-y-5 p-10"
    >
      {CLOSER_DOTS.map((d) => (
        <span
          key={d.i}
          className={'closer-dot ' + (d.live ? 'closer-dot-live' : '')}
          style={d.live ? { animationDelay: `${d.delay}s` } : undefined}
        />
      ))}
    </div>
  );
}


/**
 * NOTE ON <main>: overflow-x is CLIP, not hidden.
 *
 * `overflow-x: hidden` forces the other axis to `auto`, which turns <main>
 * into a scroll container. Framer's useScroll then binds to <main> rather
 * than the document, and because <main> never actually scrolls (its
 * clientHeight equals its scrollHeight, the document is what moves), every
 * scroll-linked animation freezes at progress 0.
 *
 * `clip` clips the axis without creating a scroll container. Do not change
 * it back.
 */
export default function Landing() {
  return (
    <main className="overflow-x-clip">
      {/* ------------------------------------------------ nav */}
      <div className="sticky top-4 z-50 px-4">
        <nav className="nav-pill mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <span className="display text-2xl leading-none">Nukkad</span>

          <div className="flex items-center gap-5 text-sm">
            <Link href="/sim" className="hidden hover:text-[var(--hot)] md:block">
              Demo
            </Link>
            <Link href="/login" className="hover:text-[var(--hot)]">
              Login
            </Link>
            <Link
              href="/signup"
              className="rounded-xl border border-[var(--line-2)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--ink)]"
            >
              Add your shop
            </Link>
          </div>
        </nav>
      </div>

      {/* ------------------------------------------------ hero */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        {/* The stage. Its aspect ratio is locked to the SVG's viewBox so the
            pill and the ribbon share one coordinate space and stay joined at
            every width. Without the lock, preserveAspectRatio letterboxes the
            SVG and the pill drifts off the junction. */}
        <div className="relative lg:aspect-[1152/736]">
          <HeroFlow />
          <VoicePill pinned />

          <div className="relative z-10 pt-16 text-center sm:pt-24">
          <h1
            className="display rise text-[clamp(3rem,9vw,7.5rem)]"
            style={{ animationDelay: '0ms' }}
          >
            Before it
            <br />
            <span className="display-italic">runs out.</span>
          </h1>

          <p
            className="rise muted mx-auto mt-8 max-w-lg text-lg leading-relaxed"
            style={{ animationDelay: '90ms' }}
          >
            A household buys almost the same groceries every month. Nukkad
            keeps that count, sends the order before anything runs out, and the
            customer taps once.
          </p>

            {/* Below lg the curves are hidden, so the pinned pill has nothing
                to connect to. Show it in normal flow instead. */}
            <div className="rise mt-14 lg:hidden" style={{ animationDelay: '180ms' }}>
              <VoicePill />
            </div>
          </div>
        </div>

        {/* THE BEFORE / AFTER CARD.
            Split down the middle: warm paper for the human utterance, ink
            for what the system resolved it to. The colour change IS the
            argument, which is why this is no longer one pale panel. */}
        <div
          className="split-card rise relative z-10 mt-4 lg:mt-0"
          style={{ animationDelay: '260ms' }}
        >
          <div className="grid lg:grid-cols-2">
            {/* ---------- what a person actually said ---------- */}
            <div className="bg-[var(--sand)] p-7 sm:p-10">
              <div className="flex items-center gap-2">
                <span className="breathe inline-block h-2 w-2 rounded-full bg-[var(--hot)]" />
                <span className="display-italic text-lg text-[var(--muted)]">
                  what the customer said
                </span>
              </div>
              <p className="display mt-5 text-2xl leading-tight sm:text-[32px]">
                &ldquo;bhaiya wo peela wala tel aur do kilo ashirwaad ata bhej
                dena, aur haan chai patti bhi&rdquo;
              </p>
              <p className="muted mt-5 text-sm leading-relaxed">
                Misspelled, half a brand name, and one item with no name at
                all. The way people actually talk.
              </p>
            </div>

            {/* ---------- what the system resolved ---------- */}
            <div className="bg-[var(--ink)] p-7 text-[var(--bg)] sm:p-10">
              <span className="display-italic text-lg text-[var(--bg)]/55">
                what the shop understood
              </span>
              <ul className="mt-5 space-y-3.5 text-lg">
                <li className="flex items-baseline justify-between gap-4">
                  <span className="polish-inv">1 &times; Sundrop Sunflower Oil 1L</span>
                  <span className="shrink-0 rounded-full bg-[var(--hot)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ink)]">
                    substituted
                  </span>
                </li>
                <li className="flex items-baseline justify-between gap-4">
                  <span className="polish-inv">2 &times; Aashirvaad Atta 5kg</span>
                  <span className="shrink-0 text-sm text-[var(--bg)]/55">Rs 570</span>
                </li>
                <li className="flex items-baseline justify-between gap-4">
                  <span className="polish-inv">1 &times; Tata Tea Gold 500g</span>
                  <span className="shrink-0 text-sm text-[var(--bg)]/55">Rs 305</span>
                </li>
              </ul>
              <p className="mt-6 border-t border-[var(--bg)]/15 pt-5 text-sm leading-relaxed text-[var(--bg)]/70">
                Fortune was out of stock, so Sundrop was chosen, and that was
                settled <b className="text-[var(--bg)]">before</b> this card
                went out. The customer is asked once, not twice.
              </p>
            </div>
          </div>

          {/* sits on the seam, so the card reads left-to-right as one move */}
          <span className="split-seam hidden lg:grid">&rarr;</span>
        </div>
      </section>

      {/* --------------------------------- scroll-scrubbed video, view 1 */}
      <ScrollVideo />

      {/* ------------------------------------------------ dark band: marquee */}
      <section className="bg-[var(--ink)] py-16 text-[var(--bg)]">
        <div className="ticker-mask mt-8 overflow-hidden">
          <div className="ticker-track">
            {[0, 1].map((dup) => (
              <div key={dup} className="flex shrink-0" aria-hidden={dup === 1}>
                {SAID.map((s) => (
                  <span
                    key={s + dup}
                    className="display mx-6 whitespace-nowrap text-3xl text-[var(--bg)]/80 sm:text-5xl"
                  >
                    {s}
                    <span className="mx-6 text-[var(--hot)]">&bull;</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
        <p className="muted mx-auto mt-8 max-w-6xl px-6 text-sm text-[var(--faint)]">
          Nobody types like this. So we listen, and match it against the
          shop&apos;s own catalogue.
        </p>
      </section>

      {/* --------------------------------- scroll-scrubbed depletion */}
      <DepletionScroll />

      {/* ------------------------------ four-panel comic, scroll-played */}
      <ComicScroll />



      {/* ------------------------------------------- accuracy, three up */}
      {/* Was a dark band with a paragraph and a table, and nobody was going
          to read it. Same three numbers, told as flat colour blocks with a
          chunky icon each and one line of copy. The percentages carry it. */}
      <section className="mx-auto max-w-6xl px-6 pt-28 pb-12">
        <Reveal>
          <h2 className="display mx-auto max-w-3xl text-center text-[clamp(2.25rem,5.5vw,4rem)]">
            Not hearing it right.
            <br />
            <span className="display-italic">Recognising it right.</span>
          </h2>
        </Reveal>

        <div className="mt-16 grid items-start gap-10 md:grid-cols-3 md:gap-4">
          {[
            {
              pct: '0%',
              label: 'Audio alone',
              line: 'Hear the words, pull out the item. Nobody has beaten this ceiling.',
              tint: 'var(--hot)',
              icon: <IconAudioOnly />,
            },
            {
              pct: '75%',
              label: 'Add the shop catalogue',
              line: 'Stop transcribing. Pick from the four hundred things this shop stocks.',
              tint: 'var(--amber)',
              icon: <IconCatalogue />,
            },
            {
              pct: '100%',
              label: 'Add their last order',
              line: 'Weight it by what this household buys every single month.',
              tint: 'var(--green)',
              icon: <IconHistory />,
            },
          ].map((c, i) => (
            <Reveal key={c.pct} delay={i * 110}>
              <div className="relative text-center">
                {/* connector, desktop only */}
                {i > 0 && (
                  <span
                    aria-hidden
                    className="absolute -left-4 top-[52px] hidden text-2xl text-[var(--line-2)] md:block"
                  >
                    &rarr;
                  </span>
                )}

                <div className="mx-auto grid h-[112px] w-[132px] place-items-center">
                  {c.icon}
                </div>

                <p
                  className="display mt-5 text-[clamp(3rem,7vw,4.5rem)] leading-none"
                  style={{ color: c.tint }}
                >
                  {c.pct}
                </p>
                <h3 className="mt-3 text-lg font-semibold">{c.label}</h3>
                <p className="muted mx-auto mt-2 max-w-[15rem] text-sm leading-relaxed">
                  {c.line}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------ catalogue */}
      <section className="mx-auto max-w-6xl px-6 pt-16 pb-28">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <Reveal>
            <h2 className="display text-[clamp(2.25rem,5.5vw,4rem)]">
              Upload a bill.
              <br />
              The rest fills itself.
            </h2>

            <p className="muted mt-7 text-lg leading-relaxed">
              Four hundred items typed by hand is a two-hour evening. That wall
              is why shopkeepers give up on software like this.
            </p>

            {/* the three facts, as a list rather than another paragraph */}
            <ul className="mt-8 space-y-4">
              {[
                ['Names, quantities and rates', 'lifted straight off the bill'],
                ['Cost price', 'so your margin is worked out for you'],
                ['Local names', 'we suggest them, you tap to accept'],
              ].map(([bold, rest]) => (
                <li key={bold} className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--hot)]" />
                  <span className="leading-relaxed">
                    <b>{bold}</b> <span className="muted">{rest}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={110}>
            <BillToCatalogue />
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------ faq */}
      <section className="mx-auto max-w-3xl px-6 pb-28">
        <Reveal>
          <h2 className="display text-[clamp(2.25rem,5.5vw,4rem)]">
            Fair questions.
          </h2>
        </Reveal>
        <div className="mt-10 divide-y divide-[var(--line)]">
          {FAQ.map((f, i) => (
            <Reveal key={f.q} delay={i * 60}>
              {/* Same `name` on every one makes them an exclusive accordion:
                  opening one closes the rest. Native since Chrome 120 /
                  Safari 17.2 / Firefox 130, so this stays a server component
                  with no JavaScript. Older browsers just allow several open,
                  which is a fine degradation. */}
              <details name="faq" className="group py-6">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-lg font-medium">
                  {f.q}
                  <span className="muted shrink-0 text-2xl transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="muted mt-4 leading-relaxed">{f.a}</p>
              </details>
            </Reveal>
          ))}
        </div>
      </section>

      {/* --------------------------------------------- closing statement */}
      {/* The last thing anyone sees. Full-bleed ink, the largest type on
          the site, and the old "Get started" panel folded into it so two
          calls to action do not sit back to back competing. */}
      <section className="closer">
        <ShopField />
        <span className="closer-glow" />

        <div className="relative z-10 mx-auto flex min-h-[86vh] max-w-5xl flex-col items-center justify-center px-6 py-28 text-center">
          <Reveal>
            <h2 className="display text-[clamp(2.5rem,8vw,6.5rem)] text-[var(--bg)]">
              The shop that knows
              <br />
              your name should
              <br />
              <span className="display-italic">know your order.</span>
            </h2>
          </Reveal>

          <Reveal delay={180}>
            <p className="mt-10 max-w-md text-lg leading-relaxed text-[var(--bg)]/65">
              There are thirteen million kirana stores in India. Not one of
              them needs a new app, a new device, or a new habit. They already
              have the phone, and they already have the customer.
            </p>
          </Reveal>

          <Reveal delay={260}>
            <div className="mt-12 flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/signup"
                className="rounded-xl bg-[var(--accent)] px-8 py-4 text-lg font-semibold text-[var(--ink)]"
              >
                Add your shop
              </Link>
              <Link
                href="/sim"
                className="rounded-xl border border-[var(--bg)]/30 px-8 py-4 text-lg font-medium text-[var(--bg)]"
              >
                Try the demo
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------ footer */}
      {/* No top border: the closing section above is full-bleed ink, so
          the colour change is already the divide. */}
      <footer className="pt-20 pb-10">
        <div className="mx-auto max-w-6xl px-6 [container-type:inline-size]">
          {/* THE WORDMARK. Sized to fill the column, which is why the
              clamp maximum is set against max-w-6xl rather than left to
              run on with the viewport. */}
          <div className="flex items-center gap-[3.2cqw]">
            <VoiceMark className="h-[clamp(1.75rem,12.6cqw,9rem)] w-auto shrink-0 overflow-visible" />
            {/* Solved, not guessed. Measured in the browser: "Nukkad" in EB
                Garamond at this tracking renders 2.982em wide. The mark and
                gap take 15.4 + 3.2 = 18.6cqw of the column, leaving 81.4cqw
                for the name, so 81.4 / 2.982 = 27.3cqw of font size fills it.
                27.1 is that, shaved for sub-pixel rounding.

                Re-measure the ratio if the word or the face ever changes. It
                is per-word: the name was Dobara at 2.696em, and carrying that
                number over to Nukkad overflowed the column by 8%.

                It has to be cqw, not vw. vw counts the scrollbar gutter and
                the column does not, so a vw solve overshoots by the scrollbar
                width and clips the last letter. cqw resolves against this
                container's content box, which is the box being filled. */}
            <span className="display text-[clamp(2.75rem,27.1cqw,18.7rem)] leading-[0.8]">
              Nukkad
            </span>
          </div>

          {/* the quiet row */}
          <div className="mt-14 flex flex-wrap items-center justify-between gap-x-8 gap-y-5 border-t border-[var(--line)] pt-8">
            <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
              {/* the crossing, with the shop on the corner of it */}
              <span className="corner-badge grid h-9 w-9 shrink-0 place-items-center rounded-full">
                <svg viewBox="0 0 24 24" aria-hidden className="h-[17px] w-[17px]">
                  <path
                    d="M11 2v20M2 13h20"
                    stroke="var(--ink)"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                  />
                  <circle
                    className="corner-dot"
                    cx="17"
                    cy="7"
                    r="3.2"
                    fill="var(--hot)"
                    stroke="var(--ink)"
                    strokeWidth="2"
                  />
                </svg>
              </span>
              <span className="muted text-sm">Nukkad 2026</span>
              <Link href="/sim" className="text-sm hover:text-[var(--hot)]">
                Demo
              </Link>
              <Link href="/login" className="text-sm hover:text-[var(--hot)]">
                Login
              </Link>
              <Link href="/signup" className="text-sm hover:text-[var(--hot)]">
                Add your shop
              </Link>
            </div>

            <span className="muted text-sm">
              Built for the Razorpay AI Buildathon
            </span>
          </div>
        </div>
      </footer>
    </main>
  );
}
