import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { contentHash } from '../hash.ts';
import type { DefinitionTag, FileTags, ReferenceTag } from './tags.ts';
import type { LanguageId } from '../types.ts';

/**
 * The repo map's disk cache — per-file tags, keyed by content hash, JSON on disk.
 *
 * Modelled on Aider's repo-map tags cache (https://aider.chat/docs/repomap.html),
 * with one deliberate substitution: Aider persists through SQLite; this repo ships
 * zero new runtime dependencies, so entries are plain JSON files under a directory
 * **the caller explicitly hands in**. smelt never writes outside a store or cache it
 * was handed — no default location, no home-directory guessing.
 *
 * The key is a content hash over the tag-format version, the language, and the file's
 * exact text. That is the whole invalidation story: edit a file and its key changes,
 * so the stale entry is simply never looked up again. Nothing needs a timestamp.
 *
 * A corrupt entry — unparseable JSON, or JSON of the wrong shape — is **discarded
 * loudly, never trusted**: the entry file is deleted, the tags are re-extracted from
 * source, and the caller's result carries a warning naming the file. Trusting a
 * damaged cache would silently drop symbols from the map, which is this project's
 * signature failure mode.
 */

/** The format name every cache entry carries. */
export const TAGS_CACHE_FORMAT = 'smelt-repomap-tags';

/** Bump this when the tag shape changes: old entries then miss instead of misleading. */
export const TAGS_CACHE_VERSION = 1;

/**
 * The cache key for one file's tags. The version and language are part of the hashed
 * material, so a format bump or a re-detected language can never resurrect an entry
 * extracted under different rules.
 */
export function tagsCacheKey(language: LanguageId, content: string): string {
  return contentHash(`${TAGS_CACHE_FORMAT}/${String(TAGS_CACHE_VERSION)}\0${language}\0${content}`);
}

/** What `read()` reports about one lookup. */
export type TagsCacheLookup = FileTags | 'corrupt' | undefined;

export class TagsCache {
  readonly #entriesDir: string;

  /** `dir` is the directory the caller handed in; entries live under `<dir>/tags/`. */
  constructor(dir: string) {
    this.#entriesDir = join(dir, 'tags');
    mkdirSync(this.#entriesDir, { recursive: true });
  }

  /**
   * The cached tags under `key`, `undefined` on a miss, `'corrupt'` when an entry
   * existed but could not be trusted — in which case it has already been deleted, so
   * the corruption is reported exactly once and never re-read.
   */
  read(key: string): TagsCacheLookup {
    let raw: string;
    try {
      raw = readFileSync(this.#entryPath(key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#discard(key);
      return 'corrupt';
    }
    const tags = validateEntry(parsed);
    if (tags === undefined) {
      this.#discard(key);
      return 'corrupt';
    }
    return tags;
  }

  /**
   * Persist one file's tags. Written to a temp name and renamed into place, so a
   * concurrent reader never sees a half-written entry; both writers of the same key
   * are writing identical bytes (the key covers the content), so last-rename-wins is
   * harmless. No fsync: unlike the elision store, every entry here is derivable from
   * source, so losing one to a crash costs a re-parse, not a broken promise.
   */
  write(key: string, tags: FileTags): void {
    const body = `${JSON.stringify({
      format: TAGS_CACHE_FORMAT,
      version: TAGS_CACHE_VERSION,
      defs: tags.defs,
      refs: tags.refs,
    })}\n`;
    const target = this.#entryPath(key);
    const temp = `${target}.tmp-${String(process.pid)}`;
    writeFileSync(temp, body, 'utf8');
    renameSync(temp, target);
  }

  #entryPath(key: string): string {
    return join(this.#entriesDir, `${key}.json`);
  }

  /** Delete a corrupt entry so it can never be re-read as truth. Best effort. */
  #discard(key: string): void {
    try {
      unlinkSync(this.#entryPath(key));
    } catch {
      // Already gone, or undeletable — either way it will be overwritten by the
      // rewrite that follows every discard.
    }
  }
}

/** The parsed entry as `FileTags`, or `undefined` when its shape cannot be trusted. */
function validateEntry(parsed: unknown): FileTags | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const entry = parsed as { format?: unknown; version?: unknown; defs?: unknown; refs?: unknown };
  if (entry.format !== TAGS_CACHE_FORMAT || entry.version !== TAGS_CACHE_VERSION) return undefined;
  if (!Array.isArray(entry.defs) || !Array.isArray(entry.refs)) return undefined;

  const defs: DefinitionTag[] = [];
  for (const item of entry.defs as unknown[]) {
    const def = item as { name?: unknown; kind?: unknown; line?: unknown };
    if (typeof def.name !== 'string' || def.name === '') return undefined;
    if (typeof def.kind !== 'string' || def.kind === '') return undefined;
    if (typeof def.line !== 'number' || !Number.isInteger(def.line) || def.line < 1) {
      return undefined;
    }
    defs.push({ name: def.name, kind: def.kind, line: def.line });
  }
  const refs: ReferenceTag[] = [];
  for (const item of entry.refs as unknown[]) {
    const ref = item as { name?: unknown; count?: unknown };
    if (typeof ref.name !== 'string' || ref.name === '') return undefined;
    if (typeof ref.count !== 'number' || !Number.isInteger(ref.count) || ref.count < 1) {
      return undefined;
    }
    refs.push({ name: ref.name, count: ref.count });
  }
  return { defs, refs };
}
