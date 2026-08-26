import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const here = path.dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  /**
   * Pin the workspace root.
   *
   * Next infers it from the nearest lockfile walking upward. On a machine
   * that happens to have another lockfile in a parent directory it picks
   * that one, warns, and resolves modules from the wrong tree. Vercel only
   * clones this repo so it would infer correctly there, but pinning keeps
   * local and CI builds identical rather than merely usually identical.
   */
  turbopack: { root: path.join(here, '..', '..') },
};

export default config;
