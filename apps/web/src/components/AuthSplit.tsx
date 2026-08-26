import Link from 'next/link';
import { VoiceMark } from './VoiceMark';

/* ---------------------------------------------------------------------
   The argument for signing up, made in line art.

   One object drawn twice: the steel jar an Indian kitchen keeps its atta
   in. Empty on the left, refilled on the right. The only difference
   between the two drawings is a call going out, which is the product.
   --------------------------------------------------------------------- */

/** the jar outline, shared by both states */
const LID = { x: 44, y: 20, w: 72, h: 18, r: 7 };
const BODY =
  'M56 38 C44 44 38 58 38 76 L38 158 Q38 176 56 176 L104 176 Q122 176 122 158 L122 76 C122 58 116 44 104 38';

/** a wavy line for the surface of the contents, spanning the jar width */
const surface = (y: number) => `M39 ${y} q10.4 -4.5 20.8 0 t20.8 0 t20.8 0 t20.8 0`;

function Jar({
  id,
  state,
}: {
  id: string;
  state: 'empty' | 'full';
}) {
  const empty = state === 'empty';

  return (
    <svg viewBox="0 0 160 200" className="h-auto w-full" aria-hidden>
      <defs>
        {/* contents are clipped to the jar so they can scale freely */}
        <clipPath id={`${id}-clip`}>
          <path d={`${BODY} Z`} />
        </clipPath>
      </defs>

      <g className={empty ? 'jar-dim' : 'jar-lit'}>
        {/* contents */}
        <g clipPath={`url(#${id}-clip)`}>
          <rect
            className={empty ? 'jar-drain' : 'jar-refill'}
            x="34"
            y="64"
            width="92"
            height="116"
            fill="var(--hot)"
            opacity={empty ? 0.22 : 0.32}
          />
        </g>

        {/* where it used to sit, on the empty jar only */}
        {empty && <path className="jar-was" d="M40 68 H120" />}

        {/* the jar itself */}
        <path className="jar-line" d={BODY} />
        <rect
          className="jar-line"
          x={LID.x}
          y={LID.y}
          width={LID.w}
          height={LID.h}
          rx={LID.r}
        />
        <path className="jar-line" d={surface(empty ? 168 : 74)} opacity={0.75} />
      </g>

      {/* the call leaving the second jar. This is the entire difference. */}
      {!empty && (
        <g
          className="jar-ping"
          stroke="var(--hot)"
          strokeWidth="2.2"
          strokeLinecap="round"
          fill="none"
        >
          <path d="M132 84 a 14 14 0 0 1 0 20" />
          <path d="M140 76 a 26 26 0 0 1 0 36" />
          <path d="M148 68 a 38 38 0 0 1 0 52" />
        </g>
      )}
    </svg>
  );
}

function Stage() {
  return (
    <aside className="auth-stage hidden lg:flex lg:flex-col lg:justify-center lg:px-12 xl:px-16">
      <div className="absolute top-10 left-12 z-10 flex items-center gap-3 xl:left-16">
        <VoiceMark tone="cream" className="h-5 w-auto" />
        <span className="display text-xl text-[var(--bg)]">Nukkad</span>
      </div>

      <div className="relative z-10 mx-auto w-full max-w-[440px]">
        <div className="flex items-center gap-6">
          <figure className="flex-1">
            <Jar id="a" state="empty" />
            <figcaption className="mt-5 text-center text-[13px] text-[var(--bg)]/40">
              empty
            </figcaption>
          </figure>

          <span className="auth-arrow shrink-0 pb-9 text-2xl text-[var(--bg)]/45">
            &rarr;
          </span>

          <figure className="flex-1">
            <Jar id="b" state="full" />
            <figcaption className="mt-5 text-center text-[13px] text-[var(--bg)]">
              refilled
            </figcaption>
          </figure>
        </div>

        <p className="display mt-14 text-center text-[26px] leading-snug text-[var(--bg)]">
          The shop calls
          <br />
          <span className="display-italic">before the jar does.</span>
        </p>
      </div>
    </aside>
  );
}

/**
 * Split auth shell. Form at left on cream, the argument at right on ink.
 *
 * The stage is display:none below lg rather than stacked underneath. On a
 * phone the form is the entire job, and a shopkeeper who has already tapped
 * through to signup does not need to be sold to again on the way.
 */
export function AuthSplit({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen lg:grid lg:grid-cols-2 xl:grid-cols-[1fr_1.05fr]">
      <div className="flex min-h-screen flex-col px-6 py-10 sm:px-10 lg:px-14 xl:px-20">
        <Link href="/" className="flex items-center gap-2.5 lg:hidden">
          <VoiceMark className="h-4 w-auto" />
          <span className="display text-lg">Nukkad</span>
        </Link>

        <div className="flex flex-1 items-center">
          <div className="mx-auto w-full max-w-[400px] py-10">{children}</div>
        </div>

        <Link
          href="/"
          className="muted text-xs transition-colors hover:text-[var(--hot)]"
        >
          &larr; Back to home
        </Link>
      </div>

      <Stage />
    </main>
  );
}
