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
 * This test fails if any module reachable from the public entrypoint can reach the
 * network. It is a *partition of a discovered set*, not an allowlist over an assumed
 * one: it walks the real import graph and classifies every edge it finds into exactly
 * one of five buckets. An import that matches nothing — a transport nobody thought to
 * forbid — lands in "unclassified" and fails. Forgetting cannot be silent.
 *
 * Three separate holes are closed here, because each one has let a check pass while
 * doing nothing:
 *
 *  1. *Vacuous pass* — a walker with a broken entrypoint visits zero files and reports
 *     success. `it('actually walked the graph')` asserts real coverage.
 *  2. *Unwalked file* — a new module nobody imported yet, or imported only from a test,
 *     would never be scanned. Every discovered file must be reachable or explicitly
 *     declared unreachable.
 *  3. *Unclassified dependency* — a package added to `package.json` that no list
 *     mentions. Checked directly against the manifest.
 *
 * Watching it fail is not optional. See CONTRIBUTING.md § "A guard nobody has watched
 * fail is not a guard" for the recorded transcript, and `pnpm mutate` to reproduce it.
 */

const ENTRYPOINT = 'index.ts';

/**
 * Modules that are legitimately not reachable from `index.ts`. Empty today, and it must
 * stay justified line by line — this is the escape hatch, so it is the thing to be
 * suspicious of in review.
 */
const UNREACHABLE_BY_DESIGN: readonly string[] = [];

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
}

function walk(root: string): WalkResult {
  const visited: string[] = [];
  const edges: (Edge & { classification: Classification })[] = [];
  const queue = [ENTRYPOINT];

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
  return { visited, edges };
}

describe('Law 1 — zero network', () => {
  const root = guardSrcRoot();
  const result = walk(root);

  it('actually walked the graph (a guard that visits nothing passes vacuously)', () => {
    expect(result.visited).toContain(ENTRYPOINT);
    expect(result.visited.length).toBeGreaterThanOrEqual(8);
    expect(result.edges.length).toBeGreaterThanOrEqual(15);
    // The two modules with the most dangerous surface must be in the walk, by name.
    expect(result.visited).toContain('net/policy.ts');
    expect(result.visited).toContain('plan/grammar.ts');
  });

  it('reaches every source file, or says why not', () => {
    const discovered = allSourceFiles(root);
    const unreached = discovered.filter(
      (file) => !result.visited.includes(file) && !UNREACHABLE_BY_DESIGN.includes(file),
    );
    expect(
      unreached,
      `these modules are never reached from ${ENTRYPOINT}, so nothing scans them for ` +
        `network access. Export them from the entrypoint, or justify them in ` +
        `UNREACHABLE_BY_DESIGN.`,
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

  it('never touches a network global', () => {
    const violations: string[] = [];
    for (const file of result.visited) {
      const code = stripStringsAndComments(readSource(file, root));
      for (const global of FORBIDDEN_GLOBALS) {
        const pattern = new RegExp(`(?<![.\\w$'"])${global}\\b`);
        if (pattern.test(code)) violations.push(`${file} references \`${global}\``);
      }
    }
    expect(violations, 'Law 1 violation: network-capable global in the elision path').toEqual([]);
  });

  it('declares no dependency that could reach the network', () => {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
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
