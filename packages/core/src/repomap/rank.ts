import type { FileTags } from './tags.ts';

/**
 * Deterministic PageRank over the cross-file reference graph.
 *
 * Modelled on Aider's repo-map ranking (https://aider.chat/docs/repomap.html; see
 * `aider/repomap.py` in https://github.com/Aider-AI/aider): files are the graph's
 * nodes, and a file that references an identifier defined in another file contributes
 * a weighted edge toward the definer. A file's rank is then distributed across its
 * definitions in proportion to the reference weight each one attracted. The idea is
 * Aider's; only the implementation is this repository's.
 *
 * Deterministic by construction, which is what makes the map snapshot-testable:
 * fixed damping, a fixed iteration count, nodes visited in sorted-path order, and a
 * total tie-break (rank, then path, then name, then line). No `Math.random`, no
 * `Date`, no map-iteration order leaking into the output.
 */

/** The damping factor. 0.85 is the classic PageRank constant; fixed, never sampled. */
export const PAGERANK_DAMPING = 0.85;

/** Fixed iteration count — no convergence test, so runtime and output never vary. */
export const PAGERANK_ITERATIONS = 50;

/** What the caller hands the ranker: one file's path and its extracted tags. */
export interface FileTagsEntry {
  readonly path: string;
  readonly tags: FileTags;
}

/** One definition with its computed rank and the measured counts that explain it. */
export interface RankedDefinition {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  /** Accumulated PageRank share. `0` when no other file references this name. */
  readonly rank: number;
  /** Total references to this name across every scanned file (its own included). */
  readonly refsIn: number;
  /** Distinct files holding at least one of those references. */
  readonly refsInFiles: number;
  /** References the defining file makes to names defined in *other* files. */
  readonly refsOut: number;
}

/**
 * Rank every definition in the tag set.
 *
 * Only cross-file references move rank — a file citing its own definitions does not
 * boost itself — but `refsIn`/`refsInFiles` count every reference, so the explanation
 * a symbol carries never hides same-file usage.
 *
 * Returns all definitions (rank `0` included), sorted by rank descending with the
 * stable tie-break: path ascending, then name ascending, then line ascending.
 */
export function rankDefinitions(files: readonly FileTagsEntry[]): readonly RankedDefinition[] {
  const sorted = [...files].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const paths = sorted.map((file) => file.path);

  // Which files define each identifier, and every definition, in deterministic order.
  interface MutableDef {
    readonly path: string;
    readonly name: string;
    readonly kind: string;
    readonly line: number;
    rank: number;
  }
  const defsByName = new Map<string, MutableDef[]>();
  const allDefs: MutableDef[] = [];
  for (const { path, tags } of sorted) {
    for (const def of tags.defs) {
      const mutable: MutableDef = { path, name: def.name, kind: def.kind, line: def.line, rank: 0 };
      allDefs.push(mutable);
      const existing = defsByName.get(def.name);
      if (existing === undefined) defsByName.set(def.name, [mutable]);
      else existing.push(mutable);
    }
  }

  // Cross-file edges: referencing file → defining file, weighted by reference count.
  // outWeight is each file's total outgoing weight — the PageRank edge denominator,
  // which legitimately grows once per definer file so each edge keeps its full weight.
  // refsOutByFile is the *measured* count a Law 2 explanation may quote: it adds
  // `ref.count` exactly once per reference to a name some other file defines, no
  // matter how many files define it. edgeWeights aggregates per file pair for the
  // PageRank pass, while rank distribution below re-walks the refs so each
  // *definition* receives its own share.
  const outWeight = new Map<string, number>(paths.map((path) => [path, 0]));
  const refsOutByFile = new Map<string, number>(paths.map((path) => [path, 0]));
  const edgeWeights = new Map<string, Map<string, number>>(paths.map((path) => [path, new Map()]));
  const refsInTotal = new Map<string, number>();
  const refsInFiles = new Map<string, number>();
  for (const { path, tags } of sorted) {
    for (const ref of tags.refs) {
      const definers = defsByName.get(ref.name);
      if (definers === undefined) continue;
      refsInTotal.set(ref.name, (refsInTotal.get(ref.name) ?? 0) + ref.count);
      refsInFiles.set(ref.name, (refsInFiles.get(ref.name) ?? 0) + 1);
      const targets = new Set(definers.map((def) => def.path));
      let crossFile = false;
      for (const target of [...targets].toSorted()) {
        if (target === path) continue;
        crossFile = true;
        outWeight.set(path, (outWeight.get(path) ?? 0) + ref.count);
        const row = edgeWeights.get(path)!;
        row.set(target, (row.get(target) ?? 0) + ref.count);
      }
      if (crossFile) refsOutByFile.set(path, (refsOutByFile.get(path) ?? 0) + ref.count);
    }
  }

  // PageRank, fixed iterations. Dangling files (no outgoing weight) spread their rank
  // uniformly, the standard treatment; every sum runs in sorted-path order so the
  // floating-point result is identical on every run.
  const nodeCount = paths.length;
  let rank = new Map<string, number>(
    paths.map((path) => [path, nodeCount === 0 ? 0 : 1 / nodeCount]),
  );
  for (let iteration = 0; iteration < PAGERANK_ITERATIONS; iteration += 1) {
    let danglingSum = 0;
    for (const path of paths) {
      if (outWeight.get(path) === 0) danglingSum += rank.get(path)!;
    }
    const next = new Map<string, number>();
    const base =
      nodeCount === 0
        ? 0
        : (1 - PAGERANK_DAMPING) / nodeCount + (PAGERANK_DAMPING * danglingSum) / nodeCount;
    for (const path of paths) next.set(path, base);
    for (const source of paths) {
      const total = outWeight.get(source)!;
      if (total === 0) continue;
      const share = (PAGERANK_DAMPING * rank.get(source)!) / total;
      for (const [target, weight] of edgeWeights.get(source)!) {
        next.set(target, next.get(target)! + share * weight);
      }
    }
    rank = next;
  }

  // Distribute each file's rank across the definitions that attracted it, exactly the
  // way Aider does: every cross-file reference edge hands the referencing file's rank,
  // scaled by the edge's share of that file's outgoing weight, to the definition it
  // points at.
  for (const { path, tags } of sorted) {
    const total = outWeight.get(path)!;
    if (total === 0) continue;
    const sourceRank = rank.get(path)!;
    for (const ref of tags.refs) {
      const definers = defsByName.get(ref.name);
      if (definers === undefined) continue;
      for (const def of definers) {
        if (def.path === path) continue;
        def.rank += (sourceRank * ref.count) / total;
      }
    }
  }

  const ranked: RankedDefinition[] = allDefs.map((def) => ({
    path: def.path,
    name: def.name,
    kind: def.kind,
    line: def.line,
    rank: def.rank,
    refsIn: refsInTotal.get(def.name) ?? 0,
    refsInFiles: refsInFiles.get(def.name) ?? 0,
    refsOut: refsOutByFile.get(def.path) ?? 0,
  }));
  return ranked.toSorted(compareRanked);
}

/**
 * The total order every emitted map obeys: rank descending, then the stable
 * tie-break by path, name, and line. Total, so equal-rank symbols land in the same
 * place on every run and on every machine — remove any leg of it and the map's
 * byte-for-byte determinism claim quietly dies.
 */
function compareRanked(a: RankedDefinition, b: RankedDefinition): number {
  if (a.rank !== b.rank) return a.rank > b.rank ? -1 : 1;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.line - b.line;
}
