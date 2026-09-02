import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

import { importSpecifiers, readSource } from './source.ts';

/**
 * THE IMPORT-GRAPH WALKER — the machine both packages' Law 1 guards run on.
 *
 * It walks the real import graph of a package's `src`, starting at every front door
 * the package's own manifest advertises, and hands back what it found. It makes no
 * ruling: what counts as an allowed dependency is each package's business, expressed
 * as one `classify(edge)` function (the core partitions its edges into five buckets;
 * the mcp package adds a stdio-only SDK subpath allowlist). The walker's job is the
 * part that must not be maintained twice — the traversal, and the four holes below.
 *
 * **Four separate holes are closed here, because each one has let a check pass while
 * doing nothing:**
 *
 *  1. *Vacuous pass* — a walker with a broken entrypoint visits zero files and reports
 *     success. `assertNoNetwork` asserts real coverage against a floor the package
 *     states (`coverage.minVisited` / `minEdges` / `mustVisit`).
 *  2. *Unwalked file* — a new module nobody imported yet, or imported only from a test,
 *     would never be scanned. Every discovered file must be reachable or explicitly
 *     declared unreachable (`unreachableByDesign`).
 *  3. *Unclassified dependency* — a package added to `package.json` that no list
 *     mentions. Two halves: an unclassified *edge* fails here, and the *manifest's*
 *     declared dependencies are checked directly by each package's own ruling, since
 *     "which dependencies are vetted" is exactly what differs between them.
 *  4. *Unwalked entrypoint* — the CLI. A `bin` is a second front door, and a walk that
 *     only started at `index.ts` would never scan it, so the most argv-shaped, most
 *     tempting place to add a network call would be the one place unguarded. The
 *     entrypoints are therefore **derived from `exports` and `bin` in the manifest**,
 *     never listed in a guard: adding a binary adds it to the walk automatically.
 *
 * Watching it fail is not optional. See CONTRIBUTING.md § "A guard nobody has watched
 * fail is not a guard" for the recorded transcript, and `pnpm mutate` to reproduce it.
 *
 * This package carries no `test/guards/` of its own, so `scripts/mutate.mjs` — which
 * discovers guard-bearing packages by that directory — correctly passes it by. That is
 * not a gap: every Law 1 mutation in both packages runs *through* this walker, so a
 * walker that stopped walking would show up as mutations surviving, which the runner
 * reports as a hole in the guard and exits 1 on.
 */

/** The slice of a package manifest the walk and the rulings read. */
export interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly exports?: unknown;
  readonly bin?: Record<string, string>;
  readonly files?: readonly string[];
}

/** A package's real manifest, read from its real root — never from the mutant copy. */
export function readManifest(packageRoot: string): Manifest {
  return JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as Manifest;
}

/**
 * Every `dist/**.js` path anywhere inside a JSON value, normalized without the `./`
 * prefix — npm 11's publish validation strips `./` from `bin` values (and removed the
 * whole entry when it carried one), so both spellings must count as the same front door.
 */
export function distPaths(value: unknown, found: string[] = []): readonly string[] {
  if (typeof value === 'string') {
    const normalized = value.startsWith('./') ? value.slice(2) : value;
    if (/^dist\/.+\.js$/.test(normalized)) found.push(`./${normalized}`);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) distPaths(item, found);
    return found;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) distPaths(item, found);
  }
  return found;
}

/**
 * The published front doors, as source paths.
 *
 * Derived from the manifest so it cannot fall behind it: every `./dist/x/y.js` the
 * package advertises maps to `x/y.ts` in `src`. A declared entrypoint with no source
 * file is a failure, not a skip — that would be the vacuous case wearing a new hat.
 */
export function entrypoints(root: string, manifest: Manifest): readonly string[] {
  const { exports: exported, bin } = manifest;
  const declared = [...new Set([...distPaths(exported), ...distPaths(bin)])].toSorted();

  const missing: string[] = [];
  const sources = declared.map((path) => {
    const source = path.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts');
    if (!existsSync(join(root, source))) missing.push(`${path} → src/${source}`);
    return source;
  });
  if (missing.length > 0) {
    throw new Error(
      `the manifest advertises entrypoints with no source file: ${missing.join(', ')}. ` +
        `The zero-network walk starts at these, so a broken mapping would silently ` +
        `shrink the guard.`,
    );
  }
  return sources;
}

/** One import, as found: the file it is written in, and the specifier it names. */
export interface Edge {
  readonly from: string;
  readonly specifier: string;
}

/**
 * What an edge is, once a package's ruling has been applied. The `relative` bucket is
 * the walker's own — a relative specifier resolves to a file in the same tree or to
 * nothing, which is a fact, not a ruling — so a package's `classify` only ever sees
 * bare specifiers and only ever returns the other four.
 */
export type Classification =
  | { readonly kind: 'relative'; readonly target: string }
  | { readonly kind: 'allowed-builtin' }
  | { readonly kind: 'allowed-package' }
  | { readonly kind: 'forbidden'; readonly why: string }
  | { readonly kind: 'unclassified' };

/**
 * THE SEAM. One small function per package, carrying only that package's ruling on
 * bare specifiers: which builtins, which dependencies, which subpaths. Anything it
 * does not recognise must come back `unclassified` — an import nobody thought to
 * forbid fails the guard rather than passing it.
 */
export type Classify = (edge: Edge) => Classification;

/** Where a relative specifier lands: a real file in the tree, or nothing. */
function resolveRelative(edge: Edge, root: string): Classification {
  const target = posix.normalize(posix.join(posix.dirname(edge.from), edge.specifier));
  for (const candidate of [target, `${target}.ts`, `${target}/index.ts`]) {
    if (existsSync(join(root, candidate))) return { kind: 'relative', target: candidate };
  }
  return { kind: 'forbidden', why: `relative import "${edge.specifier}" resolves to nothing` };
}

/** The walker's resolution first, the package's ruling second. */
export function classifyEdge(edge: Edge, root: string, ruling: Classify): Classification {
  return edge.specifier.startsWith('.') ? resolveRelative(edge, root) : ruling(edge);
}

export interface WalkResult {
  /** The tree that was walked — `SMELT_GUARD_SRC` when the mutation runner set it. */
  readonly root: string;
  /** The manifest the front doors were derived from, carried so the assertions can pin it. */
  readonly manifest: Manifest;
  readonly visited: readonly string[];
  readonly edges: readonly Edge[];
  readonly entrypoints: readonly string[];
}

/**
 * Walk the import graph from every manifest-advertised front door, breadth-first,
 * following relative edges into the same tree and recording every edge it passes —
 * including the ones it does not follow, which are the ones a ruling must judge.
 */
export function walkImportGraph({
  root,
  manifest,
}: {
  readonly root: string;
  readonly manifest: Manifest;
}): WalkResult {
  const visited: string[] = [];
  const edges: Edge[] = [];
  const starts = entrypoints(root, manifest);
  const queue = [...starts];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.includes(file)) continue;
    if (!existsSync(join(root, file))) continue;
    visited.push(file);

    for (const specifier of importSpecifiers(readSource(file, root))) {
      const edge: Edge = { from: file, specifier };
      edges.push(edge);
      const resolution = classifyEdge(edge, root, () => ({ kind: 'unclassified' }));
      if (resolution.kind === 'relative') queue.push(resolution.target);
    }
  }
  return { root, manifest, visited, edges, entrypoints: starts };
}
