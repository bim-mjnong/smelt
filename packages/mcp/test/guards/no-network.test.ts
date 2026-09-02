import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_NODE_BUILTINS,
  FORBIDDEN_GLOBALS,
  FORBIDDEN_NODE_MODULES,
  FORBIDDEN_PACKAGES,
} from '@smeltjs/core';

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
 * ZERO-NETWORK GUARD for the MCP package — Law 1, plus this package's own ruling:
 * **stdio-local only**.
 *
 * The sanctioned dependency, `@modelcontextprotocol/sdk`, ships HTTP and SSE
 * transports alongside stdio. Vetting "the package" would therefore vet a network
 * server into the graph; what was actually sanctioned is the *stdio* slice. So this
 * guard does what the core's guard does — walks the real import graph from every
 * manifest entrypoint and classifies every edge into exactly one bucket — and pins
 * the SDK to an explicit subpath allowlist ({@link ALLOWED_SDK_SUBPATHS}): stdio
 * transport, the server class, the protocol types, nothing else. An SDK subpath off
 * that list (`server/sse.js`, `server/streamableHttp.js`) is forbidden, not
 * unclassified — the guard names the ruling it breaks.
 *
 * The forbidden lists are imported from `@smeltjs/core`'s own `net/policy.ts` — the
 * one place Law 1 is written down — so the two packages cannot drift on what counts
 * as a transport. The core package itself is vetted by the core's guard; this one
 * covers OUR source files: no `fetch`, no `node:http(s)`, no WebSocket, anywhere in
 * `packages/mcp/src`.
 */

/** The only `@modelcontextprotocol/sdk` subpaths any module here may import. */
const ALLOWED_SDK_SUBPATHS: readonly string[] = [
  '@modelcontextprotocol/sdk/server/index.js', // the low-level Server class
  '@modelcontextprotocol/sdk/server/stdio.js', // the one sanctioned transport
  '@modelcontextprotocol/sdk/types.js', // request schemas and result types
];

/** The complete vetted runtime dependency set — anything else in the manifest fails. */
const VETTED_DEPENDENCIES: readonly string[] = ['@modelcontextprotocol/sdk', '@smeltjs/core'];

/** Node builtins OUR modules may import, each with its reason. */
const ALLOWED_MCP_BUILTINS: readonly string[] = [
  'node:fs', // reading the manifest, a smelt_file path, a stat for repo_map
  'node:path', // resolving tool paths against the server cwd
  'node:process', // cwd, stderr, and the exit code, for the binary
];

/** Modules legitimately unreachable from any entrypoint. Empty, and staying so. */
const UNREACHABLE_BY_DESIGN: readonly string[] = [];

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly exports?: unknown;
  readonly bin?: Record<string, string>;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(resolve(packageRoot(), 'package.json'), 'utf8')) as Manifest;
}

/** Every `dist/**.js` path anywhere inside a JSON value — see the core guard. */
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

/** The published front doors, as source paths, derived from `exports` + `bin`. */
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
  if (
    specifier === '@modelcontextprotocol/sdk' ||
    specifier.startsWith('@modelcontextprotocol/sdk/')
  ) {
    if (ALLOWED_SDK_SUBPATHS.includes(specifier)) return { kind: 'allowed-package' };
    return {
      kind: 'forbidden',
      why:
        `"${specifier}" is not on the stdio-local SDK allowlist. This server is ` +
        `stdio-local by ruling: the SDK's HTTP/SSE transports never enter this graph. ` +
        `Allowed: ${ALLOWED_SDK_SUBPATHS.join(', ')}.`,
    };
  }
  if (specifier === '@smeltjs/core') return { kind: 'allowed-package' };
  if (ALLOWED_MCP_BUILTINS.includes(specifier)) return { kind: 'allowed-builtin' };
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

describe('Law 1 for @smeltjs/mcp — zero network, stdio-local', () => {
  const root = guardSrcRoot();
  const result = walk(root);

  it('starts from every front door the manifest advertises', () => {
    expect(
      result.entrypoints.length,
      'no entrypoints derived from the manifest — the walk would be vacuous',
    ).toBeGreaterThanOrEqual(2);
    expect(result.entrypoints).toContain('index.ts');
    expect(result.entrypoints).toContain('bin.ts');
    const { bin } = manifest();
    expect(
      Object.keys(bin ?? {}),
      'the server ships as a `bin` (npx @smeltjs/mcp) and the walk starts from it',
    ).toContain('smelt-mcp');
    for (const entry of result.entrypoints) expect(result.visited).toContain(entry);
  });

  it('actually walked the graph (a guard that visits nothing passes vacuously)', () => {
    expect(result.visited.length).toBeGreaterThanOrEqual(4);
    expect(result.edges.length).toBeGreaterThanOrEqual(8);
    // The modules with the most dangerous surface must be in the walk, by name.
    expect(result.visited).toContain('server.ts');
    expect(result.visited).toContain('store.ts');
    expect(result.visited).toContain('bin.ts');
  });

  it('reaches every source file, or says why not', () => {
    const discovered = allSourceFiles(root);
    const unreached = discovered.filter(
      (file) => !result.visited.includes(file) && !UNREACHABLE_BY_DESIGN.includes(file),
    );
    expect(
      unreached,
      `these modules are never reached from any manifest entrypoint, so nothing scans ` +
        `them for network access. Export them from the entrypoint, reach them from the ` +
        `bin, or justify them in UNREACHABLE_BY_DESIGN.`,
    ).toEqual([]);
  });

  it('imports no network transport, and no SDK subpath off the stdio-local allowlist', () => {
    const violations = result.edges
      .filter((edge) => edge.classification.kind === 'forbidden')
      .map(
        (edge) =>
          `${edge.from} → ${edge.specifier}: ${(edge.classification as { why: string }).why}`,
      );
    expect(violations, 'Law 1 violation: this server makes zero network calls').toEqual([]);
  });

  it('classifies every import it found (an unknown import is a failure, not a pass)', () => {
    const unknown = result.edges
      .filter((edge) => edge.classification.kind === 'unclassified')
      .map((edge) => `${edge.from} → ${edge.specifier}`);
    expect(
      unknown,
      'unclassified import. Add it to ALLOWED_MCP_BUILTINS or ALLOWED_SDK_SUBPATHS in ' +
        'this guard, with a comment saying why it cannot reach the network — or accept ' +
        'that it is forbidden.',
    ).toEqual([]);
  });

  it('never touches a network global — bare, or qualified through the global object', () => {
    const violations: string[] = [];
    for (const file of result.visited) {
      const code = stripStringsAndComments(readSource(file, root));
      for (const global of FORBIDDEN_GLOBALS) {
        const pattern = new RegExp(
          `(?<![.\\w$'"])${global}\\b` +
            `|(?<![\\w$])(?:globalThis|global|window|self)\\s*\\.\\s*${global}\\b`,
        );
        if (pattern.test(code)) violations.push(`${file} references \`${global}\``);
      }
    }
    expect(violations, 'Law 1 violation: network-capable global in the MCP server').toEqual([]);
  });

  it('declares exactly the vetted runtime dependencies, and nothing more', () => {
    const declared = [
      ...Object.keys(manifest().dependencies ?? {}),
      ...Object.keys(manifest().peerDependencies ?? {}),
    ].toSorted();
    expect(
      declared,
      'the runtime dependency set moved. The SDK is the one sanctioned addition ' +
        '(stdio-local); anything further needs its own vetting and its own ruling.',
    ).toEqual([...VETTED_DEPENDENCIES].toSorted());
  });

  it('imports the sanctioned node builtins only through the allowlist above', () => {
    // Every builtin on the local list must also be one the core's policy already
    // allows — the mcp package gets no builtin the library itself refuses.
    const unvetted = ALLOWED_MCP_BUILTINS.filter((name) => !ALLOWED_NODE_BUILTINS.includes(name));
    expect(
      unvetted,
      'a builtin allowed here is not on @smeltjs/core net/policy.ts ALLOWED_NODE_BUILTINS',
    ).toEqual([]);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `packages/mcp/src` and asserts this file goes red — see `_mutations.ts` and
 * `scripts/mutate.mjs`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'mcp-law1-node-https-import',
    file: 'server.ts',
    find: "import { readFileSync, statSync } from 'node:fs';",
    replace: "import 'node:https';\nimport { readFileSync, statSync } from 'node:fs';",
    why: 'a network transport imported directly into the MCP server',
  },
  {
    id: 'mcp-law1-global-fetch',
    file: 'store.ts',
    find: 'export function resolveMcpStore(cwd: string): ResolvedMcpStore {',
    replace: 'export function resolveMcpStore(cwd: string): ResolvedMcpStore {\n  void fetch;',
    why: 'a network-capable global referenced without any import at all',
  },
  {
    id: 'mcp-law1-http-transport-subpath',
    file: 'server.ts',
    find: "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
    replace:
      "import '@modelcontextprotocol/sdk/server/sse.js';\n" +
      "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
    why:
      'an HTTP/SSE transport subpath of the sanctioned SDK — the package name is vetted, ' +
      'the network half of it is not, so the guard must pin subpaths rather than the name',
  },
  {
    id: 'mcp-law1-unclassified-package',
    file: 'bin.ts',
    find: "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
    replace:
      "import 'some-package-nobody-vetted';\n" +
      "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
    why: 'a dependency that matches no list — the case a forbidden-list alone misses',
  },
];
