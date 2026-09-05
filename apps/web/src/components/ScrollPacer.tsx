'use client';

import { useEffect } from 'react';

const WHEEL_SCALE = 0.48;
const MAX_STEP = 180;

function normaliseWheel(delta: number, mode: number) {
  if (mode === 1) return delta * 16;
  if (mode === 2) return delta * window.innerHeight;
  return delta;
}

function clampStep(value: number) {
  return Math.max(-MAX_STEP, Math.min(MAX_STEP, value));
}

export function ScrollPacer() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;

    function onWheel(event: WheelEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;

      event.preventDefault();
      const dy = clampStep(normaliseWheel(event.deltaY, event.deltaMode) * WHEEL_SCALE);
      window.scrollBy({ top: dy, left: 0, behavior: 'auto' });
    }

    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  return null;
}
