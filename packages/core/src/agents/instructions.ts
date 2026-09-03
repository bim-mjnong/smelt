import { join } from 'node:path';

import { DEFAULT_REPO_IGNORE } from '../repomap/map.ts';
import { nodeFsReader } from '../repomap/reader.ts';
import type { RepoReader } from '../repomap/reader.ts';

/**
 * The instruction files an agent actually loads, found through the read-only
 * {@link RepoReader} seam.
 *
 * **Why the merged set, and not just the root file** (ruling R8): the guide's own rule
 * is that a nested `AGENTS.md` *merges with* the root one rather than replacing it, so
 * a lint that reported only the root file would be reporting a fraction and calling it
 * the total, which is this repository's Law 4 pointed at its own output.
 *
 * **But a merge runs up the tree, not across it.** Two numbers come out of that, and
 * they are different numbers in any monorepo, so both are reported and each is labelled
 * with the question it answers:
 *
 *  - {@link InstructionSet.perRequestBytes} — the most any *one* request loads: a level
 *    plus its **ancestors**. An agent working in `pkg/a` loads the root file and
 *    `pkg/a`'s; it never loads `pkg/b`'s, because siblings do not merge. This is the
 *    per-request cost, and it is the number the guide's argument is about.
 *  - {@link InstructionSet.totalBytes} — every level's primary summed: the whole
 *    repository's instruction surface. Useful as the size of what a team maintains,
 *    and **not** a per-request cost. Calling it one would be the same over-count this
 *    module refuses for mirrors one paragraph down.
 *
 * **Why a mirror is not a level.** Claude Code reads `CLAUDE.md`, Gemini reads
 * `GEMINI.md`, Codex and the rest read `AGENTS.md`. One agent loads *one* of them, so
 * summing all three would triple a cost nobody pays. At each directory the primary is
 * the file the level contributes — `AGENTS.md` when it exists, otherwise whichever
 * mirror is there alone — and the others are {@link InstructionLevel.mirrors}, counted
 * for drift and not for bytes.
 *
 * **Why the reader is a seam.** Every claim the lint makes is a claim about a *walk*:
 * that a nested file was found, that an ignored directory was never entered, that a
 * path in the prose resolves against the real tree. Those are claims about calls, so
 * they are asserted by counting calls against a stub tree (`test/repo-reader-stub.ts`),
 * exactly as the repo map's walk is. The default is {@link nodeFsReader}, so nothing
 * changes for a caller who does not care.
 */

/** The three file names a coding agent reads instructions from, in precedence order. */
export const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const;

/** One of the three names above. */
export type InstructionFileName = (typeof INSTRUCTION_FILE_NAMES)[number];

/** True for a name this module treats as an instruction file. */
export function isInstructionFileName(name: string): name is InstructionFileName {
  return (INSTRUCTION_FILE_NAMES as readonly string[]).includes(name);
}

/** One instruction file on disk, read. */
export interface InstructionFile {
  /** Root-relative and `/`-separated, e.g. `packages/core/AGENTS.md`. */
  readonly path: string;
  readonly name: InstructionFileName;
  /** The directory it sits in, root-relative; `''` for the repository root. */
  readonly dir: string;
  readonly text: string;
  /** UTF-8 bytes. The unit every smelt budget is in. */
  readonly bytes: number;
  /**
   * True when the entry is a symlink — the arrangement the guide recommends for
   * mirrors, and the one arrangement in which a mirror **cannot** drift.
   */
  readonly symlink: boolean;
}

/**
 * One directory's contribution: the file that level costs, plus the mirrors of it.
 *
 * `primary` is the only one whose bytes are summed. A mirror that differs from it is
 * `mirror-drift`; a mirror that is a symlink cannot differ, which is the whole reason
 * the guide suggests one.
 */
export interface InstructionLevel {
  /** Root-relative directory; `''` is the root level. */
  readonly dir: string;
  readonly primary: InstructionFile;
  readonly mirrors: readonly InstructionFile[];
}

/** Every instruction file in a tree, arranged by level. */
export interface InstructionSet {
  /** The directory the walk started from, as the caller spelled it. */
  readonly root: string;
  /** Root level first, then nested levels in walk order. */
  readonly levels: readonly InstructionLevel[];
  /**
   * The repository-wide instruction surface: every level's primary, summed.
   *
   * **Not a per-request cost.** Sibling levels never merge, so no single request ever
   * loads all of these — see {@link perRequestBytes} for the number that answers that
   * question.
   */
  readonly totalBytes: number;
  /**
   * What the most expensive single request loads: the heaviest level plus every level
   * above it, since a nested file merges with its **ancestors** and with nothing else.
   *
   * Equal to {@link totalBytes} in a repository with one chain of levels, and strictly
   * smaller as soon as two siblings both carry an instruction file.
   */
  readonly perRequestBytes: number;
}

/** How deep the walk goes. Instruction files near the root are the ones agents read. */
const MAX_DEPTH = 6;

/**
 * Find and read every instruction file under `root`.
 *
 * The ignore list is the repo map's, and for the same reason: a vendored
 * `node_modules/**\/AGENTS.md` is not this repository's instruction to an agent, and
 * counting it would make the total a number about somebody else's project. A caller
 * may replace the list wholesale — a default nobody can turn off is not a default.
 *
 * Symlinked *directories* are refused outright, exactly as the map refuses them: a
 * walk that follows one can leave the root. A symlinked instruction **file** is read
 * (following it is the point — that is what the harness does too) and flagged.
 */
export function readInstructionSet(options: {
  readonly root: string;
  readonly reader?: RepoReader;
  readonly ignore?: readonly string[];
}): InstructionSet {
  const reader = options.reader ?? nodeFsReader();
  const ignore = options.ignore ?? DEFAULT_REPO_IGNORE;
  const found: InstructionFile[] = [];

  const walk = (dir: string, depth: number): void => {
    const entries = reader
      .list(dir === '' ? options.root : join(options.root, dir))
      .map((entry) => entry.name)
      .toSorted();

    for (const name of entries) {
      const relative = dir === '' ? name : `${dir}/${name}`;
      if (isIgnored(relative, ignore)) continue;
      const stat = reader.stat(join(options.root, relative));
      if (stat === undefined) continue;
      if (stat.isDirectory && !stat.isSymlink) {
        if (depth < MAX_DEPTH) walk(relative, depth + 1);
        continue;
      }
      if (!isInstructionFileName(name)) continue;
      // A symlinked instruction file is **read**, unlike a symlinked directory, which
      // is refused. Following it is the point: it is the arrangement the guide
      // recommends for mirrors, and it is exactly what the harness does when it opens
      // `CLAUDE.md`. Two readers disagree about how to describe one, and both are
      // accommodated here: `nodeFsReader` lstats, so a link is `isSymlink` and *not*
      // `isFile`; a resolving reader answers about the target, so it is both.
      if (!stat.isFile && !stat.isSymlink) continue;
      let raw: Uint8Array;
      try {
        raw = reader.read(join(options.root, relative));
      } catch {
        // A broken symlink, or a file that vanished between the stat and the read.
        // Nothing is loaded on every request, so there is nothing to report.
        continue;
      }
      found.push({
        path: relative,
        name,
        dir,
        text: new TextDecoder('utf-8').decode(raw),
        // The bytes on disk, straight off the read — never `Buffer.byteLength(text)`.
        // Decoding and re-encoding is not the identity: a UTF-8 BOM is dropped on the
        // way in (19 bytes read, 16 reported) and a byte that is not valid UTF-8 comes
        // back as a three-byte U+FFFD. Both skew the one number this verb exists to
        // state, in opposite directions, against a figure the harness measures on the
        // file itself. `stat.size` is not the answer either: on a symlinked mirror
        // `lstat` sizes the *link*, and following it is the point.
        bytes: raw.byteLength,
        symlink: stat.isSymlink,
      });
    }
  };

  walk('', 0);

  const byDir = new Map<string, InstructionFile[]>();
  for (const file of found) {
    const bucket = byDir.get(file.dir);
    if (bucket === undefined) byDir.set(file.dir, [file]);
    else bucket.push(file);
  }

  const levels: InstructionLevel[] = [...byDir.entries()]
    // Root first, then by depth and then alphabetically: the order a reader would
    // walk the tree in, so a report reads top-down.
    .toSorted(([a], [b]) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([dir, files]) => {
      const ordered = files.toSorted(
        (a, b) => INSTRUCTION_FILE_NAMES.indexOf(a.name) - INSTRUCTION_FILE_NAMES.indexOf(b.name),
      );
      return { dir, primary: ordered[0]!, mirrors: ordered.slice(1) };
    });

  return {
    root: options.root,
    levels,
    totalBytes: levels.reduce((sum, level) => sum + level.primary.bytes, 0),
    perRequestBytes: heaviestChainBytes(levels),
  };
}

/**
 * The heaviest ancestor chain: the most any single request can load.
 *
 * A request made in `pkg/a` merges the root level with `pkg/a`'s, and stops. `pkg/b` is
 * a sibling, and no agent loads a sibling — so the maximum over chains is the honest
 * per-request figure, and the sum over levels is not one.
 */
function heaviestChainBytes(levels: readonly InstructionLevel[]): number {
  const bytesByDir = new Map(levels.map((level) => [level.dir, level.primary.bytes]));
  let heaviest = 0;
  for (const level of levels) {
    const chain = ancestorDirs(level.dir).reduce(
      (sum, dir) => sum + (bytesByDir.get(dir) ?? 0),
      level.primary.bytes,
    );
    heaviest = Math.max(heaviest, chain);
  }
  return heaviest;
}

/**
 * The directories a level merges *with*, root first and nearest last — and never the
 * level itself.
 *
 * The whole distinction `restated-at-level` and {@link InstructionSet.perRequestBytes}
 * both turn on: `pkg/a` merges with `''` and `pkg`, and with nothing else in the tree.
 */
export function ancestorDirs(dir: string): readonly string[] {
  if (dir === '') return [];
  const segments = dir.split('/');
  const out: string[] = [''];
  for (let cut = 1; cut < segments.length; cut += 1) out.push(segments.slice(0, cut).join('/'));
  return out;
}

/** `''` is depth 0; `a/b` is depth 2. */
function depthOf(dir: string): number {
  return dir === '' ? 0 : dir.split('/').length;
}

/**
 * The repo map's ignore semantics, restated over root-relative paths: a bare name
 * matches any path segment, an entry containing `/` is a root-relative prefix.
 */
function isIgnored(relative: string, ignore: readonly string[]): boolean {
  const segments = relative.split('/');
  return ignore.some((entry) => {
    const trimmed = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    if (trimmed === '') return false;
    if (entry.includes('/')) {
      return relative === trimmed || relative.startsWith(`${trimmed}/`);
    }
    return segments.includes(trimmed);
  });
}

/**
 * Does `token`, read as a path relative to the repository root, name something that
 * exists? The one question `dead-path` and `dead-link` both ask.
 *
 * Through the reader, so the resolution is part of the same injectable walk the
 * discovery is — a fixture repo can therefore contain a path that resolves and one
 * that does not without either of them existing on the machine running the tests.
 * A reader that throws (a malformed path, a permission error) answers "no": the
 * finding is advisory, and a lint that failed the whole run because one token in
 * somebody's prose was unstattable would be worse than the staleness it looks for.
 */
export function resolvesInTree(root: string, reader: RepoReader, token: string): boolean {
  try {
    return reader.stat(join(root, token)) !== undefined;
  } catch {
    return false;
  }
}
