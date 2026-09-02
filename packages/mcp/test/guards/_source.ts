import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as kit from '@smelt/guard-kit';

/**
 * This package's guard anchor — the same arrangement as
 * `packages/core/test/guards/_source.ts`. The helpers live once, in
 * `@smelt/guard-kit`; only this package's own location is bound here, so a guard
 * reads whatever tree `SMELT_GUARD_SRC` points at and the mutation runner can point
 * it at a deliberately broken copy without touching the working tree.
 */

/** This package's real root, regardless of where the guard source is pointed. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

/** The repository root. */
export function repoRoot(): string {
  return resolve(packageRoot(), '../..');
}

/** The tree the guard is pointed at — this package's `src`, or the mutant copy. */
export function guardSrcRoot(): string {
  return kit.guardSrcRoot(packageRoot());
}

/** The tree a file-level guard reads committed artefacts from. */
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
