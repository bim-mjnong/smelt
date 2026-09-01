import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The guards import the library through `@guard/*` instead of a relative path, so the
 * mutation runner can aim them at a *deliberately broken copy* of `src` and watch them
 * go red. See `scripts/mutate.mjs` and CONTRIBUTING.md § "A guard nobody has watched
 * fail is not a guard". Everything else imports relatively, as normal.
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
