import { expect, it } from 'vitest';

import { allSourceFiles, readSource, stripStringsAndComments } from './source.ts';
import { classifyEdge, type Classify, type WalkResult } from './walk.ts';

/**
 * The Law 1 assertions, run over a walk one package's ruling classifies.
 *
 * Everything here is the same in both packages: the vacuity defences, the
 * reachability partition, the forbidden/unclassified partition of the discovered
 * edges, and the network-global scan. What differs is passed in — the `classify`
 * seam, the coverage floor, and the manifest half of hole 3, which each package
 * asserts itself because "which dependencies are vetted" is precisely its ruling.
 *
 * Call it from inside a `describe`; it registers `it`s.
 */

/**
 * The vacuity floor, per package: what a walk must have reached before its silence
 * counts as evidence. Numbers a package states about itself, not thresholds anyone
 * tunes — see hole 1 in `walk.ts`.
 */
export interface WalkCoverage {
  /** Front doors that must be among the derived entrypoints (`index.ts`, a `bin`). */
  readonly entrypoints: readonly string[];
  /** `bin` names the manifest must still advertise — losing one shrinks the walk. */
  readonly bin: readonly string[];
  /** Why losing that bin would matter, in this package's words. */
  readonly binWhy: string;
  readonly minVisited: number;
  readonly minEdges: number;
  /** The modules with the most dangerous surface, named, so a shrunk walk is loud. */
  readonly mustVisit: readonly string[];
}

export interface NoNetworkRuling {
  readonly walk: WalkResult;
  /** This package's ruling on bare specifiers — the one thing that is not shared. */
  readonly classify: Classify;
  /**
   * Modules legitimately not reachable from any entrypoint. This is the escape hatch,
   * so it is the thing to be suspicious of in review: it must stay justified line by
   * line, and empty is the healthy state.
   */
  readonly unreachableByDesign: readonly string[];
  /** The network-capable globals to scan for — `net/policy.ts` owns the list. */
  readonly forbiddenGlobals: readonly string[];
  readonly coverage: WalkCoverage;
  readonly messages: {
    /** Printed when a forbidden edge is found. */
    readonly violation: string;
    /** Where to add a specifier this package's ruling did not recognise. */
    readonly unclassified: string;
  };
}

export function assertNoNetwork(ruling: NoNetworkRuling): void {
  const { walk, classify, unreachableByDesign, forbiddenGlobals, coverage, messages } = ruling;
  const classified = walk.edges.map((edge) => ({
    edge,
    classification: classifyEdge(edge, walk.root, classify),
  }));

  it('starts from every front door the manifest advertises', () => {
    // Hole 4: `exports` + `bin`, derived. Two is the floor because every package here
    // ships a library entry and a binary; one entrypoint means one was lost.
    expect(
      walk.entrypoints.length,
      'no entrypoints derived from the manifest — the walk would be vacuous',
    ).toBeGreaterThanOrEqual(2);
    for (const entry of coverage.entrypoints) expect(walk.entrypoints).toContain(entry);
    const binNames = Object.keys(walk.manifest.bin ?? {});
    for (const name of coverage.bin) expect(binNames, coverage.binWhy).toContain(name);
    for (const entry of walk.entrypoints) expect(walk.visited).toContain(entry);
  });

  it('actually walked the graph (a guard that visits nothing passes vacuously)', () => {
    // Hole 1.
    expect(walk.visited.length).toBeGreaterThanOrEqual(coverage.minVisited);
    expect(walk.edges.length).toBeGreaterThanOrEqual(coverage.minEdges);
    for (const file of coverage.mustVisit) expect(walk.visited).toContain(file);
  });

  it('reaches every source file, or says why not', () => {
    // Hole 2.
    const discovered = allSourceFiles(walk.root);
    const unreached = discovered.filter(
      (file) => !walk.visited.includes(file) && !unreachableByDesign.includes(file),
    );
    expect(
      unreached,
      `these modules are never reached from any manifest entrypoint, so nothing scans ` +
        `them for network access. Export them from the entrypoint, reach them from a ` +
        `\`bin\`, or justify them in UNREACHABLE_BY_DESIGN.`,
    ).toEqual([]);
  });

  it('imports nothing its ruling forbids, anywhere in the graph', () => {
    const violations = classified
      .filter((entry) => entry.classification.kind === 'forbidden')
      .map(
        (entry) =>
          `${entry.edge.from} → ${entry.edge.specifier}: ` +
          `${(entry.classification as { why: string }).why}`,
      );
    expect(violations, messages.violation).toEqual([]);
  });

  it('classifies every import it found (an unknown import is a failure, not a pass)', () => {
    // Hole 3, edge half. An import nobody thought to forbid lands here and fails;
    // forgetting cannot be silent.
    const unknown = classified
      .filter((entry) => entry.classification.kind === 'unclassified')
      .map((entry) => `${entry.edge.from} → ${entry.edge.specifier}`);
    expect(unknown, messages.unclassified).toEqual([]);
  });

  it('never touches a network global — bare, or qualified through the global object', () => {
    const violations: string[] = [];
    for (const file of walk.visited) {
      const code = stripStringsAndComments(readSource(file, walk.root));
      for (const global of forbiddenGlobals) {
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
    expect(violations, 'Law 1 violation: network-capable global in the graph').toEqual([]);
  });
}
