'use client';

import { useEffect, useState } from 'react';
import { VoiceMark } from './VoiceMark';

/**
 * Hold a loading state back for a beat.
 *
 * A request that returns in 120ms should show nothing at all. Painting a
 * loader and removing it one frame later reads as jank, not as speed, and
 * it is the single thing that makes an otherwise fast app feel cheap. Wait
 * out the short cases, and only admit to loading if it is really taking a
 * moment.
 */
export function useDelayed(ms = 240): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return show;
}

/**
 * The session check, where nothing about the page can be drawn yet because
 * we do not yet know who is asking. The mark speaks; that is true either
 * way.
 */
export function BootSplash() {
  const show = useDelayed(240);
  if (!show) return null;

  return (
    <div className="load-in grid min-h-screen place-items-center px-6">
      <div className="flex flex-col items-center">
        <div className="flex items-center gap-3.5">
          <VoiceMark className="h-7 w-auto" />
          <span className="display text-3xl">Nukkad</span>
        </div>
        <span className="boot-rail mt-7" role="status" aria-label="Loading" />
      </div>
    </div>
  );
}

/** One shimmering block. Width and height come from the caller. */
export function Skel({
  className = '',
  inverted = false,
  style,
}: {
  className?: string;
  inverted?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={`skel ${inverted ? 'skel-inv' : ''} block ${className}`}
      style={style}
      aria-hidden
    />
  );
}

/**
 * Overview, drawn empty. Same colours and the same grid as the real thing,
 * so the layout does not jump when the numbers arrive.
 */
export function OverviewSkeleton() {
  const show = useDelayed(240);
  if (!show) return null;

  return (
    <div className="load-in" role="status" aria-label="Loading the overview">
      <Skel className="h-11 w-56" />
      <Skel className="mt-3 h-4 w-80 max-w-full" />

      {/* the ink block */}
      <div className="pane-ink mt-7 p-7 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <Skel className="h-4 w-24" inverted />
          <Skel className="h-8 w-52 rounded-full" inverted />
        </div>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
          <div className="min-w-[190px]">
            <Skel className="h-14 w-52" inverted />
            <Skel className="mt-4 h-3.5 w-36" inverted />
          </div>
          <div className="flex min-w-[220px] flex-1 items-end gap-[3px]">
            {Array.from({ length: 30 }, (_, i) => (
              <Skel
                key={i}
                inverted
                className="flex-1 rounded-t"
                /* a fixed wave rather than random, so it does not reshuffle
                   on every re-render while the page is still waiting */
                style={{ height: `${18 + Math.round(Math.sin(i / 2.6) * 14 + 26)}px` }}
              />
            ))}
          </div>
        </div>
        <Skel className="mt-7 h-3 w-full max-w-md" inverted />
      </div>

      {/* the three tiles */}
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        {['tile-1', 'tile-2', 'tile-3'].map((c) => (
          <div key={c} className={`tile ${c} p-5`}>
            <Skel className="h-8 w-16 !bg-[#1a1a1a1f] !bg-none" />
            <Skel className="mt-2.5 h-3.5 w-28 !bg-[#1a1a1a14] !bg-none" />
          </div>
        ))}
      </div>

      {/* donut and calendar */}
      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1.05fr]">
        <div className="pane p-6">
          <Skel className="h-6 w-44" />
          <div className="mt-8 flex flex-col items-center gap-7 sm:flex-row">
            <span
              className="skel h-[172px] w-[172px] shrink-0"
              style={{ borderRadius: '999px' }}
              aria-hidden
            />
            <div className="w-full flex-1 space-y-3">
              {[0, 1, 2].map((i) => (
                <Skel key={i} className="h-9 w-full" />
              ))}
            </div>
          </div>
        </div>

        <div className="pane p-6">
          <Skel className="h-6 w-40" />
          <div className="mt-6 grid grid-cols-7 gap-1.5">
            {Array.from({ length: 35 }, (_, i) => (
              <Skel key={i} className="aspect-square w-full rounded-[10px]" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Rows, for the catalogue and orders tables. */
export function RowsSkeleton({ rows = 8, title = true }: { rows?: number; title?: boolean }) {
  const show = useDelayed(240);
  if (!show) return null;

  return (
    <div className="load-in" role="status" aria-label="Loading">
      {title && (
        <>
          <Skel className="h-10 w-52" />
          <Skel className="mt-3 h-4 w-72 max-w-full" />
        </>
      )}
      <div className="pane mt-7 divide-y divide-[#1a1a1a1a] p-2">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-3 py-3.5">
            <Skel className="h-4 flex-1" style={{ maxWidth: `${52 - (i % 4) * 8}%` }} />
            <Skel className="h-4 w-16 shrink-0" />
            <Skel className="h-4 w-12 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
