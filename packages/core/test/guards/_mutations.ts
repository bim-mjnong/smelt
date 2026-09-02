/**
 * The shape of one mutation: a specific, minimal break that the guard exporting it
 * must catch. Every guard file in this directory exports `MUTATIONS: GuardMutation[]`
 * beside its assertions — the break lives with the check that must notice it, so a
 * guard and its proof-of-failure travel together and review sees them side by side.
 *
 * The runner (`scripts/mutate.mjs`) discovers the guard files, extracts each
 * `MUTATIONS` literal, applies one entry at a time to a scratch copy, and asserts the
 * exporting guard goes red. Two conventions are load-bearing:
 *
 *   - **Entries are literal data.** String literals and `+` concatenation only — the
 *     runner evaluates the array in an empty sandbox where any identifier reference
 *     fails loudly. No imports, no helpers, no computed values.
 *   - **`find` must match exactly once** in the target file. A mutation that silently
 *     no-ops because the source moved is the same class of bug the guards exist to
 *     catch, so the runner makes it a hard error.
 */
export interface GuardMutation {
  /** Stable, globally unique id — `pnpm mutate` reports it, and history tracks it. */
  readonly id: string;
  /**
   * The file to break: relative to `src/` for `kind: 'src'` (the default), relative
   * to `packages/core` for `kind: 'artifact'`.
   */
  readonly file: string;
  /** The exact source string to replace. Must occur exactly once in `file`. */
  readonly find: string;
  /** What the string becomes. May be empty — deletion is a legitimate break. */
  readonly replace: string;
  /** Why this break matters: the failure the guard must be able to see. */
  readonly why: string;
  /**
   * `'src'` breaks a copy of `packages/core/src` (read via `SMELT_GUARD_SRC`);
   * `'artifact'` stales a committed artefact in a scratch root (`SMELT_GUARD_ROOT`).
   */
  readonly kind?: 'src' | 'artifact';
}
