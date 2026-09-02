import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as kit from '@smelt/guard-kit';

/**
 * This package's guard anchor.
 *
 * The helpers themselves live in `@smelt/guard-kit` — one copy, shared with
 * `packages/mcp`. What cannot be shared is *where this package is*: `packageRoot()`
 * and `repoRoot()` are derived from this file's own location, so the package binds
 * them here and the kit takes a root. The bound spellings below keep every call site
 * (`guardSrcRoot()`, `readSource(file)`) reading exactly as it did.
 */

/** This package's real root, regardless of where the guard source is pointed. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

/** The repository root. */
export function repoRoot(): string {
  return resolve(packageRoot(), '../..');
}

/**
 * The tree the guards are pointed at — this package's `src`, or the broken copy the
 * mutation runner names in `SMELT_GUARD_SRC`.
 */
export function guardSrcRoot(): string {
  return kit.guardSrcRoot(packageRoot());
}

/**
 * The tree a *file-level* guard reads its committed artefacts from — this package's
 * root, or the scratch root the mutation runner names in `SMELT_GUARD_ROOT`.
 */
export function guardRoot(): string {
  return kit.guardRoot(packageRoot());
}

/** Every `.ts` file under the guard source root, as paths relative to that root. */
export function allSourceFiles(root = guardSrcRoot()): readonly string[] {
  return kit.allSourceFiles(root);
}

export function readSource(relativePath: string, root = guardSrcRoot()): string {
  return kit.readSource(relativePath, root);
}

export { importSpecifiers, stripStringsAndComments } from '@smelt/guard-kit';
