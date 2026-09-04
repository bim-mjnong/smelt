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
    /**
     * Bound how many workers compile grammars at once.
     *
     * Nineteen of these test files load tree-sitter grammars, and `structural.test.ts`
     * loads all fifteen — 27 MB of WASM, plus V8's compilation arena on top of it.
     * With the default one-worker-per-core, several of them compile simultaneously and
     * the peak is set by the runner's core count rather than by anything this suite
     * decides. A worker died of exactly that in CI (`Fatal process out of memory:
     * Zone`) while the other fifty files passed, on a commit whose four other jobs were
     * green — the signature of a limit being grazed, not crossed.
     *
     * Three keeps real parallelism and makes the ceiling a property of this file
     * rather than of whichever machine happens to run it.
     * Clearing the grammar cache between tests was measured first and rejected: it
     * moved the peak the wrong way (910 MB to 1.1 GB), because recompiling a grammar
     * costs more arena than holding the compiled one.
     */
    maxWorkers: 3,
    env: {
      SMELT_GUARD_SRC: guardSrc,
    },
  },
});
