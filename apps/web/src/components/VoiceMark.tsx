/**
 * The Nukkad voice mark: five bars on a staggered ripple, so it reads as
 * speech being spoken rather than as a loading bar.
 *
 * Sizing is left entirely to the caller. The footer sizes it in container
 * query units against the wordmark beside it; the auth screens size it in
 * rem. Baking a size in here would make one of those wrong.
 */

const BARS = [
  { x: 0, h: 46, delay: 0 },
  { x: 26, h: 80, delay: 0.14 },
  { x: 52, h: 100, delay: 0.28 },
  { x: 78, h: 80, delay: 0.42 },
  { x: 104, h: 46, delay: 0.56 },
];

export function VoiceMark({
  className,
  tone = 'ink',
}: {
  className?: string;
  /** 'ink' on cream surfaces, 'cream' on the dark auth stage */
  tone?: 'ink' | 'cream';
}) {
  const base = tone === 'ink' ? 'var(--ink)' : 'var(--bg)';

  return (
    <svg viewBox="0 0 122 100" aria-hidden className={className}>
      {BARS.map((b) => (
        <rect
          key={b.x}
          className="mark-bar"
          x={b.x}
          y={(100 - b.h) / 2}
          width="18"
          height={b.h}
          rx="9"
          /* the centre bar always carries the accent, on either surface */
          fill={b.x === 52 ? 'var(--hot)' : base}
          style={{ animationDelay: `${b.delay}s` }}
        />
      ))}
    </svg>
  );
}
