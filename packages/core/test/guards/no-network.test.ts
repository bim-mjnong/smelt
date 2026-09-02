import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_NODE_BUILTINS,
  ALLOWED_PACKAGES,
  ALLOWED_URL_SCHEMES,
  assertLocalResource,
  FORBIDDEN_GLOBALS,
  FORBIDDEN_NODE_MODULES,
  FORBIDDEN_PACKAGES,
} from '@guard/net/policy';

import type { GuardMutation } from './_mutations.ts';
import {
  allSourceFiles,
  guardSrcRoot,
  importSpecifiers,
  packageRoot,
  readSource,
  stripStringsAndComments,
} from './_source.ts';

/**
 * ZERO-NETWORK GUARD — Law 1.
 *
 * This test fails if any module reachable from a published entrypoint can reach the
 * network. It is a *partition of a discovered set*, not an allowlist over an assumed
 * one: it walks the real import graph and classifies every edge it finds into exactly
 * one of five buckets. An import that matches nothing — a transport nobody thought to
 * forbid — lands in "unclassified" and fails. Forgetting cannot be silent.
 *
 * Four separate holes are closed here, because each one has let a check pass while
 * doing nothing:
 *
 *  1. *Vacuous pass* — a walker with a broken entrypoint visits zero files and reports
 *     success. `it('actually walked the graph')` asserts real coverage.
 *  2. *Unwalked file* — a new module nobody imported yet, or imported only from a test,
 *     would never be scanned. Every discovered file must be reachable or explicitly
 *     declared unreachable.
 *  3. *Unclassified dependency* — a package added to `package.json` that no list
 *     mentions. Checked directly against the manifest.
 *  4. *Unwalked entrypoint* — the CLI. A `bin` is a second front door, and a walk that
 *     only started at `index.ts` would never scan it, so the most argv-shaped, most
 *     tempting place to add a network call would be the one place unguarded. The
 *     entrypoints are therefore **derived from `exports` and `bin` in the manifest**,
 *     not listed here: adding a binary adds it to the walk automatically.
 *
 * Watching it fail is not optional. See CONTRIBUTING.md § "A guard nobody has watched
 * fail is not a guard" for the recorded transcript, and `pnpm mutate` to reproduce it.
 */

/**
 * Modules that are legitimately not reachable from any entrypoint. Empty today, and it
 * must stay justified line by line — this is the escape hatch, so it is the thing to be
 * suspicious of in review.
 */
const UNREACHABLE_BY_DESIGN: readonly string[] = [];

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly exports?: unknown;
  readonly bin?: Record<string, string>;
  readonly files?: readonly string[];
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(resolve(packageRoot(), 'package.json'), 'utf8')) as Manifest;
}

/**
 * Every `dist/**.js` path anywhere inside a JSON value, normalized without the `./`
 * prefix — npm 11's publish validation strips `./` from `bin` values (and removed the
 * whole entry when it carried one), so both spellings must count as the same front door.
 */
function distPaths(value: unknown, found: string[] = []): readonly string[] {
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
function entrypoints(root: string): readonly string[] {
  const { exports: exported, bin } = manifest();
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

interface Edge {
  readonly from: string;
  readonly specifier: string;
}

type Classification =
  | { readonly kind: 'relative'; readonly target: string }
  | { readonly kind: 'allowed-builtin' }
  | { readonly kind: 'allowed-package' }
  | { readonly kind: 'forbidden'; readonly why: string }
  | { readonly kind: 'unclassified' };

function classify(edge: Edge, root: string): Classification {
  const { specifier } = edge;

  if (specifier.startsWith('.')) {
    const target = posix.normalize(posix.join(posix.dirname(edge.from), specifier));
    for (const candidate of [target, `${target}.ts`, `${target}/index.ts`]) {
      if (existsSync(join(root, candidate))) return { kind: 'relative', target: candidate };
    }
    return { kind: 'forbidden', why: `relative import "${specifier}" resolves to nothing` };
  }

  if (FORBIDDEN_NODE_MODULES.includes(specifier)) {
    return { kind: 'forbidden', why: `"${specifier}" is a network transport` };
  }
  if (FORBIDDEN_PACKAGES.includes(specifier)) {
    return { kind: 'forbidden', why: `"${specifier}" is an HTTP/WebSocket client` };
  }
  if (ALLOWED_NODE_BUILTINS.includes(specifier)) return { kind: 'allowed-builtin' };
  if (ALLOWED_PACKAGES.includes(specifier)) return { kind: 'allowed-package' };
  return { kind: 'unclassified' };
}

interface WalkResult {
  readonly visited: readonly string[];
  readonly edges: readonly (Edge & { readonly classification: Classification })[];
  readonly entrypoints: readonly string[];
}

function walk(root: string): WalkResult {
  const visited: string[] = [];
  const edges: (Edge & { classification: Classification })[] = [];
  const starts = entrypoints(root);
  const queue = [...starts];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.includes(file)) continue;
    if (!existsSync(join(root, file))) continue;
    visited.push(file);

    for (const specifier of importSpecifiers(readSource(file, root))) {
      const edge: Edge = { from: file, specifier };
      const classification = classify(edge, root);
      edges.push({ ...edge, classification });
      if (classification.kind === 'relative') queue.push(classification.target);
    }
  }
  return { visited, edges, entrypoints: starts };
}

describe('Law 1 — zero network', () => {
  const root = guardSrcRoot();
  const result = walk(root);

  it('starts from every front door the manifest advertises', () => {
    expect(
      result.entrypoints.length,
      'no entrypoints derived from the manifest — the walk would be vacuous',
    ).toBeGreaterThanOrEqual(2);
    expect(result.entrypoints).toContain('index.ts');
    const { bin } = manifest();
    expect(
      Object.keys(bin ?? {}),
      'the CLI ships as a `bin` on this package (one package, one version, one install) ' +
        'and the walk starts from it, so losing the bin would quietly shrink the guard',
    ).toContain('smelt');
    for (const entry of result.entrypoints) expect(result.visited).toContain(entry);
  });

  it('actually walked the graph (a guard that visits nothing passes vacuously)', () => {
    expect(result.visited).toContain('index.ts');
    expect(result.visited.length).toBeGreaterThanOrEqual(8);
    expect(result.edges.length).toBeGreaterThanOrEqual(15);
    // The modules with the most dangerous surface must be in the walk, by name: the
    // policy itself, the grammar loader, and the CLI's argument handling.
    expect(result.visited).toContain('net/policy.ts');
    expect(result.visited).toContain('plan/grammar.ts');
    expect(result.visited).toContain('cli/args.ts');
    expect(result.visited).toContain('cli/run.ts');
  });

  it('reaches every source file, or says why not', () => {
    const discovered = allSourceFiles(root);
    const unreached = discovered.filter(
      (file) => !result.visited.includes(file) && !UNREACHABLE_BY_DESIGN.includes(file),
    );
    expect(
      unreached,
      `these modules are never reached from any manifest entrypoint, so nothing scans ` +
        `them for network access. Export them from the entrypoint, reach them from a ` +
        `\`bin\`, or justify them in UNREACHABLE_BY_DESIGN.`,
    ).toEqual([]);
  });

  it('imports no network transport, anywhere in the graph', () => {
    const violations = result.edges
      .filter((edge) => edge.classification.kind === 'forbidden')
      .map(
        (edge) =>
          `${edge.from} → ${edge.specifier}: ${(edge.classification as { why: string }).why}`,
      );
    expect(violations, 'Law 1 violation: smelt v1 makes zero network calls').toEqual([]);
  });

  it('classifies every import it found (an unknown import is a failure, not a pass)', () => {
    const unknown = result.edges
      .filter((edge) => edge.classification.kind === 'unclassified')
      .map((edge) => `${edge.from} → ${edge.specifier}`);
    expect(
      unknown,
      'unclassified import. Add it to ALLOWED_PACKAGES / ALLOWED_NODE_BUILTINS in ' +
        'src/net/policy.ts with a comment saying why it cannot reach the network — or ' +
        'to the forbidden lists.',
    ).toEqual([]);
  });

  it('never touches a network global — bare, or qualified through the global object', () => {
    const violations: string[] = [];
    for (const file of result.visited) {
      const code = stripStringsAndComments(readSource(file, root));
      for (const global of FORBIDDEN_GLOBALS) {
        // Two shapes reach the same global: the bare name, and the name behind a
        // global-object qualifier (`globalThis.fetch`, `global.fetch`, and the
        // browser-flavoured `window.`/`self.` for completeness). The bare-name
        // lookbehind deliberately rejects any `.`-prefixed match, so the qualified
        // alternative exists to close exactly that hole.
        const pattern = new RegExp(
          `(?<![.\\w$'"])${global}\\b` +
            `|(?<![\\w$])(?:globalThis|global|window|self)\\s*\\.\\s*${global}\\b`,
        );
        if (pattern.test(code)) violations.push(`${file} references \`${global}\``);
      }
    }
    expect(violations, 'Law 1 violation: network-capable global in the elision path').toEqual([]);
  });

  it('declares no dependency that could reach the network', () => {
    const declared = [
      ...Object.keys(manifest().dependencies ?? {}),
      ...Object.keys(manifest().peerDependencies ?? {}),
    ];
    expect(
      declared.length,
      'no runtime dependencies found — is the manifest right?',
    ).toBeGreaterThan(0);
    const unvetted = declared.filter((name) => !ALLOWED_PACKAGES.includes(name));
    expect(
      unvetted,
      'runtime dependency not vetted against Law 1. Add it to ALLOWED_PACKAGES in ' +
        'src/net/policy.ts, with a comment, once you have checked it cannot phone home.',
    ).toEqual([]);
  });

  it('refuses a remote resource path', () => {
    expect(ALLOWED_URL_SCHEMES).toEqual(['file:']);
    expect(() => assertLocalResource('https://example.invalid/tree-sitter-rust.wasm')).toThrow(
      /not local/,
    );
    expect(() => assertLocalResource('http://example.invalid/grammar.wasm')).toThrow(/not local/);
    expect(() => assertLocalResource(new URL('https://example.invalid/g.wasm'))).toThrow(
      /not local/,
    );
    expect(assertLocalResource('/tmp/tree-sitter-rust.wasm').protocol).toBe('file:');
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'law1-node-https-import',
    file: 'plan/lexical.ts',
    find: "import { MissingMarkerPricingError } from '../errors.ts';",
    replace: "import 'node:https';\nimport { MissingMarkerPricingError } from '../errors.ts';",
    why: 'a network transport imported directly into the elision path',
  },
  {
    id: 'law1-global-fetch',
    file: 'store.ts',
    find: '  put(content: string): string {',
    replace: '  put(content: string): string {\n    void fetch;',
    why: 'a network-capable global referenced without any import at all',
  },
  {
    id: 'law1-unclassified-package',
    file: 'retrieve.ts',
    find: "import type { ElisionStore, RetrieveTool } from './types.ts';",
    replace:
      "import 'some-package-nobody-vetted';\nimport type { ElisionStore, RetrieveTool } from './types.ts';",
    why: 'a dependency that matches no list — the case a forbidden-list alone misses',
  },
  {
    id: 'law1-remote-grammar-scheme',
    file: 'net/policy.ts',
    find: "export const ALLOWED_URL_SCHEMES: readonly string[] = ['file:'];",
    replace: "export const ALLOWED_URL_SCHEMES: readonly string[] = ['file:', 'https:'];",
    why: 'widening the scheme allowlist so a grammar could be fetched over the wire',
  },
  {
    id: 'law1-cli-network-import',
    file: 'cli/args.ts',
    find: "import { parseArgs } from 'node:util';",
    replace: "import 'node:https';\nimport { parseArgs } from 'node:util';",
    why: 'a transport in the CLI — the second front door, which a walk from index.ts alone would never scan',
  },
  {
    id: 'law1-globalthis-fetch',
    file: 'store.ts',
    find: '  has(hash: string): boolean {',
    replace: '  has(hash: string): boolean {\n    void globalThis.fetch;',
    why: 'fetch reached through the global object — `globalThis.fetch` slips past a bare-name grep whose lookbehind rejects any `.`-prefixed match, so the guard must catch the qualified spelling too',
  },
];
