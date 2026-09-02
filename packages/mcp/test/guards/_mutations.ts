/**
 * The shape of one mutation — the mcp package's copy of the core convention
 * (`packages/core/test/guards/_mutations.ts`), kept byte-compatible with what
 * `scripts/mutate.mjs` extracts: `export const MUTATIONS: GuardMutation[] = [ … ];`
 * of literal data, every `find` matching its file exactly once.
 */
export interface GuardMutation {
  /** Stable, globally unique id — `pnpm mutate` reports it, and history tracks it. */
  readonly id: string;
  /**
   * The file to break: relative to this package's `src/` for `kind: 'src'` (the
   * default), relative to the package root for `kind: 'artifact'`.
   */
  readonly file: string;
  /** The exact source string to replace. Must occur exactly once in `file`. */
  readonly find: string;
  /** What the string becomes. May be empty — deletion is a legitimate break. */
  readonly replace: string;
  /** Why this break matters: the failure the guard must be able to see. */
  readonly why: string;
  /**
   * `'src'` breaks a copy of this package's `src` (read via `SMELT_GUARD_SRC`);
   * `'artifact'` stales a committed artefact in a scratch root (`SMELT_GUARD_ROOT`).
   */
  readonly kind?: 'src' | 'artifact';
}
