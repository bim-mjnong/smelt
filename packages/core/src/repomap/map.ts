import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectLanguage } from '../detect.ts';
import { SmeltError } from '../errors.ts';
import type { LanguageId } from '../types.ts';

import { TagsCache, tagsCacheKey } from './cache.ts';
import { rankDefinitions } from './rank.ts';
import type { FileTagsEntry, RankedDefinition } from './rank.ts';
import { extractTags } from './tags.ts';
import type { FileTags } from './tags.ts';

/**
 * The repo-map builder — Slice 7, the cross-file shape.
 *
 * **Modelled on Aider's repo-map, and credited as such.** The whole design is prior
 * art: Paul Gauthier's Aider extracts tree-sitter definition/reference tags per file,
 * runs PageRank over the cross-file reference graph, fits the ranked result to a
 * budget, and caches tags on disk keyed by content — see
 * https://aider.chat/docs/repomap.html and `aider/repomap.py` in
 * https://github.com/Aider-AI/aider. Nothing about the approach is this project's
 * invention; what this module adds is only smelt's own house rules:
 *
 *  - **Local files only** (Law 1). The caller names the root; symlinks are never
 *    followed, so the walk cannot leave it; binary files are skipped; no network.
 *  - **Every inclusion is explainable** (Law 2, applied to inclusion rather than
 *    elision): each symbol in the map carries a rule id and a sentence stating its
 *    definition site and the measured reference counts that ranked it.
 *  - **Deterministic**: fixed PageRank constants, sorted walks, a total tie-break by
 *    path, name, and line. Two runs over the same tree are byte-identical.
 *  - **The budget is bytes**, same contract as the planners, and it is respected by
 *    construction: symbols are added in rank order until the next line would not fit.
 *  - **The cache lives only in a directory the caller explicitly hands in**, and a
 *    corrupt entry is discarded loudly — a warning in the result — never trusted.
 *
 * **Deliberately NOT a `Planner`.** `buildRepoMap` returns a {@link RepoMap},
 * not an `ElisionPlan`: nothing here is elided, nothing is stored under a hash, and
 * there is no original to reconstruct — the map is a *summary built up under a
 * budget*, not a *removal to be reversed*. Forcing the Planner interface onto it
 * would claim Law 3 (reversibility) about output that has no bytes to give back,
 * which is exactly the kind of lie the interface exists to prevent. The CLI serves
 * it as its own subcommand (`smelt map`), never as a `--strategy`.
 */

/** The id stamped on every map this module emits. */
export const REPO_MAP_ID = 'repomap/v1';

/**
 * Rule id for a symbol something in the scanned tree references — its own file
 * included, so its rank may still be zero when every reference is same-file (only
 * cross-file references move rank).
 */
export const REPO_MAP_RANKED_RULE = 'ranked-definition';

/** Rule id for a definition nothing in the scanned tree references. */
export const REPO_MAP_UNREFERENCED_RULE = 'unreferenced-definition';

/**
 * Rule id for a definition promoted because it matches a caller-supplied focus term.
 * The rank stays the measured PageRank share — focus moves a symbol's *place in the
 * fill order*, never its numbers.
 */
export const REPO_MAP_FOCUS_RULE = 'focus-match';

/** Rule id for a file listed by path because no definitions were extracted from it. */
export const REPO_MAP_PATH_ONLY_RULE = 'path-only';

/** Rule id for the warning left behind when a corrupt cache entry is discarded. */
export const REPO_MAP_CACHE_CORRUPT_RULE = 'cache-entry-corrupt';

/**
 * The ignore list used when the caller supplies none. Deliberately tiny: `.git` is
 * object storage, `node_modules` is other people's code. A caller with opinions passes
 * its own list, which *replaces* this one.
 */
export const DEFAULT_REPO_IGNORE: readonly string[] = ['.git', 'node_modules'];

/** Why an entry is in the map — same two-register shape as {@link ElisionReason}. */
export interface RepoMapReason {
  /** Stable machine id, e.g. `'ranked-definition'`. */
  readonly rule: string;
  /** A sentence a human can read: definition site and the counts that ranked it. */
  readonly explanation: string;
}

export interface RepoMapOptions {
  /** The repository root to read. Local files only; symlinks are never followed. */
  readonly root: string;
  /** Ceiling for the rendered map, in UTF-8 bytes. Respected, not aimed at. */
  readonly budgetBytes: number;
  /**
   * What the task is actually about — same meaning as a planner's focus. A
   * definition whose name or path contains a term (case-insensitive, like the
   * lexical planner's default) is promoted to the front of the fill order, so it
   * survives a tight budget. Promotion only: the measured rank and reference
   * counts are never altered, and each promoted entry says which term it matched.
   */
  readonly focus?: readonly string[];
  /**
   * Paths to skip, replacing {@link DEFAULT_REPO_IGNORE}. An entry containing `/` is
   * matched as a root-relative path prefix — a trailing slash counts, so `build/`
   * means the root-level `build` tree, never every `build` segment anywhere; a bare
   * name matches any path segment.
   */
  readonly ignore?: readonly string[];
  /**
   * Directory for the tags cache. **Only** when this is passed does anything touch
   * disk — smelt never writes outside a store or cache it was explicitly handed.
   */
  readonly cacheDir?: string;
}

/** One symbol included in the rendered map, with the receipt for its inclusion. */
export interface RepoMapEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  /** 1-based line of the definition. */
  readonly line: number;
  /** PageRank share this definition attracted. `0` for unreferenced definitions. */
  readonly rank: number;
  /** Measured: total references to this name across the scanned tree. */
  readonly refsIn: number;
  /** Measured: distinct files holding those references. */
  readonly refsInFiles: number;
  /** Measured: references the defining file makes to names defined elsewhere. */
  readonly refsOut: number;
  readonly reason: RepoMapReason;
}

/** A file listed by path because no definitions were extracted from it. */
export interface RepoMapPathEntry {
  readonly path: string;
  readonly reason: RepoMapReason;
}

/** Something worth telling the caller that is not worth failing the build over. */
export interface RepoMapWarning {
  readonly rule: string;
  readonly explanation: string;
}

/** Measured cache activity for one build. Counts only — smelt claims no rates. */
export interface RepoMapCacheCounts {
  /** Lookups answered from disk. */
  readonly hits: number;
  /** Lookups that found nothing and re-extracted from source. */
  readonly misses: number;
  /** Corrupt entries deleted and re-extracted; each one also left a warning. */
  readonly discarded: number;
}

export interface RepoMap {
  readonly id: typeof REPO_MAP_ID;
  /** The rendered map. Always at most `budgetBytes` UTF-8 bytes. */
  readonly text: string;
  readonly outputBytes: number;
  readonly budgetBytes: number;
  /** The symbols that fit, in fill order (focus matches first, then rank). */
  readonly entries: readonly RepoMapEntry[];
  /** Path-only files that fit, after the symbols, in path order. */
  readonly pathOnly: readonly RepoMapPathEntry[];
  /** All ranked definitions found, before the budget cut anything. */
  readonly definitionsTotal: number;
  /** All path-only candidates found, before the budget cut anything. */
  readonly pathOnlyTotal: number;
  /** Regular files examined under the root, after the ignore list. */
  readonly filesScanned: number;
  /** Files skipped because their bytes contain a NUL — binary, not mappable. */
  readonly binarySkipped: number;
  readonly warnings: readonly RepoMapWarning[];
  /** Present only when the caller handed in a `cacheDir`. Never invented. */
  readonly cache?: RepoMapCacheCounts;
}

/**
 * Build a ranked symbol map of the repository under `options.root`.
 *
 * Reads local files only. Deterministic: two runs over the same tree, with or without
 * a warm cache, produce byte-identical maps — asserted by the guard in
 * `test/guards/repo-map.test.ts`, not assumed.
 *
 * @throws {SmeltError} when `budgetBytes` is not a positive integer.
 * @throws {GrammarUnavailableError} when a supported language's grammar cannot load —
 *   never a silent skip that would make the map quietly incomplete.
 */
export async function buildRepoMap(options: RepoMapOptions): Promise<RepoMap> {
  const { root, budgetBytes } = options;
  if (!Number.isInteger(budgetBytes) || budgetBytes < 1) {
    throw new SmeltError(
      `smelt: budgetBytes must be a positive integer, got ${String(budgetBytes)}. ` +
        `There is no default budget — a budget smelt invented would silently decide ` +
        `how much of the map to throw away.`,
    );
  }
  const ignore = options.ignore ?? DEFAULT_REPO_IGNORE;
  const cache = options.cacheDir === undefined ? undefined : new TagsCache(options.cacheDir);
  const cacheCounts = { hits: 0, misses: 0, discarded: 0 };
  const warnings: RepoMapWarning[] = [];

  const files = scanFiles(root, ignore);
  let binarySkipped = 0;
  const parsed: FileTagsEntry[] = [];
  const pathOnlyPaths: string[] = [];

  for (const rel of files) {
    const bytes = readFileSync(join(root, ...rel.split('/')));
    if (bytes.includes(0)) {
      binarySkipped += 1;
      continue;
    }
    const language = detectLanguage(rel);
    if (language === 'unknown') {
      pathOnlyPaths.push(rel);
      continue;
    }
    const text = bytes.toString('utf8');
    const tags = await tagsFor(text, language, cache, cacheCounts, warnings, rel);
    if (tags.defs.length === 0) pathOnlyPaths.push(rel);
    if (tags.defs.length > 0 || tags.refs.length > 0) parsed.push({ path: rel, tags });
  }

  const ranked = rankDefinitions(parsed);
  const focus = (options.focus ?? []).filter((term) => term.length > 0);
  const ordered = orderWithFocus(ranked, focus);

  // Fit to the budget: ranked symbols first — focus matches promoted to the front,
  // each partition in rank order — then path-only files, in path order. Filling
  // stops at the first line that does not fit, so the included set is always a
  // prefix of that order — a map that skipped its #2 symbol to squeeze in its #9
  // would be lying about what mattered.
  const lines: string[] = [];
  let bytes = 0;
  const tryAppend = (line: string): boolean => {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // its trailing newline
    if (bytes + lineBytes > budgetBytes) return false;
    lines.push(line);
    bytes += lineBytes;
    return true;
  };

  const entries: RepoMapEntry[] = [];
  for (const { definition, focusTerm } of ordered) {
    if (!tryAppend(renderDefinition(definition))) break;
    entries.push(toEntry(definition, focusTerm));
  }
  const pathOnly: RepoMapPathEntry[] = [];
  if (entries.length === ordered.length) {
    for (const rel of pathOnlyPaths) {
      if (!tryAppend(`${rel} [path only]`)) break;
      pathOnly.push({
        path: rel,
        reason: {
          rule: REPO_MAP_PATH_ONLY_RULE,
          explanation: `no definitions extracted from ${rel}; listed by path so the file stays visible`,
        },
      });
    }
  }

  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return {
    id: REPO_MAP_ID,
    text,
    outputBytes: Buffer.byteLength(text, 'utf8'),
    budgetBytes,
    entries,
    pathOnly,
    definitionsTotal: ranked.length,
    pathOnlyTotal: pathOnlyPaths.length,
    filesScanned: files.length,
    binarySkipped,
    warnings,
    ...(cache === undefined ? {} : { cache: { ...cacheCounts } }),
  };
}

/** One file's tags — from the cache when possible, from the grammar when not. */
async function tagsFor(
  text: string,
  language: LanguageId,
  cache: TagsCache | undefined,
  counts: { hits: number; misses: number; discarded: number },
  warnings: RepoMapWarning[],
  rel: string,
): Promise<FileTags> {
  if (cache === undefined) return extractTags(text, language);

  const key = tagsCacheKey(language, text);
  const found = cache.read(key);
  if (found === 'corrupt') {
    counts.discarded += 1;
    warnings.push({
      rule: REPO_MAP_CACHE_CORRUPT_RULE,
      explanation:
        `discarded a corrupt cache entry for ${rel} and re-extracted its tags from ` +
        `source; the entry file was deleted so it cannot be read again`,
    });
  } else if (found !== undefined) {
    counts.hits += 1;
    return found;
  } else {
    counts.misses += 1;
  }
  const tags = await extractTags(text, language);
  cache.write(key, tags);
  return tags;
}

/**
 * Walk the tree under `root`, depth-first in sorted order, returning `/`-separated
 * relative paths of every regular file that survives the ignore list.
 *
 * Symlinks are skipped outright — file or directory, in-root or out. Never following
 * one is the simplest true implementation of "never follow a symlink out of the
 * root": there is no resolution step to get wrong.
 */
function scanFiles(root: string, ignore: readonly string[]): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string, relDir: string): void => {
    for (const entry of readdirSync(dir).toSorted()) {
      const rel = relDir === '' ? entry : `${relDir}/${entry}`;
      if (isIgnored(rel, ignore)) continue;
      const full = join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full, rel);
      else if (stat.isFile()) found.push(rel);
    }
  };
  walk(root, '');
  return found;
}

/** See {@link RepoMapOptions.ignore} for the two match modes. */
function isIgnored(rel: string, ignore: readonly string[]): boolean {
  for (const entry of ignore) {
    const cleaned = entry.replace(/\/+$/, '');
    if (cleaned === '') continue;
    // Prefix mode is decided on the entry AS WRITTEN, before the trailing slash is
    // trimmed: `build/` contains a `/` and so is the documented root-relative prefix
    // (the root-level `build` tree), not a bare name that would match a `build`
    // segment at any depth.
    if (entry.includes('/')) {
      if (rel === cleaned || rel.startsWith(`${cleaned}/`)) return true;
    } else if (rel.split('/').includes(cleaned)) {
      return true;
    }
  }
  return false;
}

/** One ranked definition in fill order, with the focus term that promoted it, if any. */
interface OrderedDefinition {
  readonly definition: RankedDefinition;
  readonly focusTerm?: string;
}

/**
 * The fill order: focus-matched definitions first, then the rest, each partition
 * keeping the ranker's total order. A stable partition of a deterministic order is
 * itself deterministic, so the map's byte-for-byte claim survives focus untouched.
 * The match is a case-insensitive substring over name and path — the lexical
 * planner's default, so "focus" means the same thing in both places — and the
 * *first* matching term in caller order is the one the receipt names.
 */
function orderWithFocus(
  ranked: readonly RankedDefinition[],
  focus: readonly string[],
): readonly OrderedDefinition[] {
  if (focus.length === 0) return ranked.map((definition) => ({ definition }));
  const needles = focus.map((term) => term.toLowerCase());
  const matched: OrderedDefinition[] = [];
  const rest: OrderedDefinition[] = [];
  for (const definition of ranked) {
    const haystack = `${definition.path}\0${definition.name}`.toLowerCase();
    const index = needles.findIndex((needle) => haystack.includes(needle));
    if (index === -1) rest.push({ definition });
    else matched.push({ definition, focusTerm: focus[index]! });
  }
  return [...matched, ...rest];
}

/** One rendered map line. Everything in it is measured, nothing estimated. */
function renderDefinition(definition: RankedDefinition): string {
  return (
    `${definition.path}:${String(definition.line)} ${definition.kind} ${definition.name} ` +
    `[${String(definition.refsIn)} in from ${String(definition.refsInFiles)} ` +
    `${plural('file', definition.refsInFiles)}, ${String(definition.refsOut)} out]`
  );
}

/** Law 2, applied to inclusion: the receipt every included symbol carries. */
function toEntry(definition: RankedDefinition, focusTerm?: string): RepoMapEntry {
  const site = `defined at ${definition.path}:${String(definition.line)}`;
  const counts =
    `${String(definition.refsIn)} ${plural('reference', definition.refsIn)} in ` +
    `from ${String(definition.refsInFiles)} ${plural('file', definition.refsInFiles)}; ` +
    `its file makes ${String(definition.refsOut)} ` +
    `${plural('reference', definition.refsOut)} out`;
  const reason: RepoMapReason =
    focusTerm !== undefined
      ? {
          rule: REPO_MAP_FOCUS_RULE,
          explanation: `${site}; matches focus "${focusTerm}"; ${counts}`,
        }
      : definition.refsIn === 0
        ? {
            rule: REPO_MAP_UNREFERENCED_RULE,
            explanation: `${site}; no references to it anywhere in the scanned tree`,
          }
        : {
            rule: REPO_MAP_RANKED_RULE,
            explanation: `${site}; ${counts}`,
          };
  return {
    path: definition.path,
    name: definition.name,
    kind: definition.kind,
    line: definition.line,
    rank: definition.rank,
    refsIn: definition.refsIn,
    refsInFiles: definition.refsInFiles,
    refsOut: definition.refsOut,
    reason,
  };
}

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
