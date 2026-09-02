import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Same arrangement as packages/core: the guard imports this package's source through
 * `@guard/*`, so the mutation runner (`scripts/mutate.mjs`) can aim it at a
 * *deliberately broken copy* of `src` via `SMELT_GUARD_SRC` and watch it go red.
 */
const guardSrc =
  process.env['SMELT_GUARD_SRC'] !== undefined && process.env['SMELT_GUARD_SRC'] !== ''
    ? process.env['SMELT_GUARD_SRC']
    : fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@guard': guardSrc },
  },
  test: {
    include: ['test/**/*.test.ts'],
    env: {
      SMELT_GUARD_SRC: guardSrc,
    },
  },
});
