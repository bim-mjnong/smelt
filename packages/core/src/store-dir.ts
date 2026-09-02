import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import process from 'node:process';

import {
  HashCollisionError,
  SmeltError,
  StoreCorruptionError,
  StoreFormatError,
  UnknownHashError,
} from './errors.ts';
import { contentHash } from './hash.ts';
import { retrieveStats } from './stats.ts';
import type { RawRetrieveCounters } from './stats.ts';
import type { ElisionStore, RetrieveStats } from './types.ts';

/**
 * The format marker every store directory carries, and the one version this code
 * understands. A future layout is a new version, refused loudly by old code — never a
 * quiet reinterpretation of someone's stored bytes.
 */
export const DIRECTORY_STORE_FORMAT = 'smelt-elision-store';
export const DIRECTORY_STORE_VERSION = 1;

/**
 * What a storage key may look like. `contentHash` produces 16 lowercase hex characters;
 * the pattern is wider so an injected test hash still works, and strict enough that a
 * key can never traverse out of `blobs/` or collide with `format.json`.
 */
const KEY_PATTERN = /^[0-9a-f]{4,128}$/;

/** One journal line: a kind, a space, and the hash as a JSON string literal. */
const LOG_LINE = /^(hit|miss|corrupt) ("(?:[^"\\]|\\.)*")$/;

/** See {@link MemoryElisionStoreOptions} in `store.ts` — same escape hatch, same reason. */
export interface DirectoryElisionStoreOptions {
  /**
   * Override the hash function, so the collision branch — unreachable with sha256 —
   * can be tested. Production has no reason to pass this.
   */
  readonly hash?: (content: string) => string;
}

/**
 * A persistent {@link ElisionStore} over a content-addressed directory. `node:fs` only —
 * no SQLite, no new dependency, nothing that phones home. Elisions put here outlive the
 * process, so a long-lived agent session can `retrieve()` across restarts.
 *
 * ## Storage layout
 *
 * ```text
 * <root>/
 *   format.json      { "format": "smelt-elision-store", "version": 1 } — refused if unknown
 *   blobs/<hash>     one file per elision: the exact UTF-8 bytes, named by their content hash
 *   tmp/             staging for atomic writes; never read, safe to sweep
 *   retrievals.log   append-only journal: `hit "<hash>"` | `miss "<hash>"` | `corrupt "<hash>"`
 * ```
 *
 * **Nothing lives in memory.** Every read — `stats()` included — comes off the disk, so
 * two instances over the same directory (two processes, or one process before and after
 * a restart) always agree. `stats()` is a scan; elision counts per session are small and
 * retrieval is the model asking for material back, which is rare by design.
 *
 * ## Durability
 *
 * - **Writes are crash-safe.** A blob is written to `tmp/`, `fsync`ed, then `link(2)`ed
 *   into `blobs/` — an atomic, no-clobber publish. A torn write dies in `tmp/`, where
 *   nothing looks; a name in `blobs/` always refers to a fully written file.
 * - **Reads verify.** `retrieve()` and `peek()` re-hash the bytes and refuse a mismatch
 *   with {@link StoreCorruptionError} — a damaged blob is never handed back as a
 *   retrieval, and "we hold damaged bytes" is distinct from {@link UnknownHashError}'s
 *   "never existed". The guard in `test/guards/persistent-store.test.ts` watches this.
 * - **Counters survive a restart.** Every `retrieve()` appends one `fsync`ed line to
 *   `retrievals.log`, and `stats()` is a fold over it — so `expansionRate` stays
 *   meaningful across a whole session, not just one process. A crash in the middle of
 *   an append can tear at most that one line; a torn tail is skipped, costing at most
 *   the single count that was being written when the process died.
 * - **Concurrent writers are safe.** `link(2)` refuses to clobber, so two processes
 *   putting at once race to publish and the loser verifies byte-for-byte agreement with
 *   the winner — identical content dedupes, different content under one hash is a
 *   {@link HashCollisionError}. Journal appends use `O_APPEND`. Tested with two real
 *   processes in `test/store-dir.test.ts`.
 *
 * ## No eviction
 *
 * Same rule as {@link MemoryElisionStore}: no cap, no LRU, no `clear()`. A store that
 * can forget turns Law 3 into "reversible, usually". Elided text is smaller than the
 * session that produced it; if disk pressure ever forces a cap, retrieval of an evicted
 * hash must throw a distinct "evicted" error — never {@link UnknownHashError} — so the
 * model can tell "we lost it" from "never existed". Today there is no such error because
 * there is no such cap.
 *
 * ## Two deliberate choices around the edges
 *
 * - **The root is resolved to an absolute path at construction.** Every later path is
 *   joined from that, so a `process.chdir()` after construction cannot silently
 *   re-target the store — the bytes a relative-rooted store put before a chdir would
 *   otherwise be unreachable after it, which reads exactly like data loss.
 * - **A failed journal append never withholds intact bytes.** `retrieve()`'s order of
 *   business is: read, verify, count, return. When the *count* cannot be written (a
 *   read-only journal, a full disk), the bytes are still returned — they are verified
 *   and the caller asked for them; refusing would turn a bookkeeping failure into
 *   Law 3 breaking. The failure is surfaced distinctly instead: a
 *   `process.emitWarning` with name `SmeltCounterWriteFailure`, so "your retrieval
 *   worked" and "your counters just went quiet" stay two separate facts. The same
 *   applies to the `miss`/`corrupt` journal lines: the store's own error for the
 *   lookup still wins over the journal's I/O error.
 */
export class DirectoryElisionStore implements ElisionStore {
  readonly #blobsDir: string;
  readonly #tmpDir: string;
  readonly #logPath: string;
  readonly #hash: (content: string) => string;

  constructor(root: string, options: DirectoryElisionStoreOptions = {}) {
    this.#hash = options.hash ?? contentHash;
    // Resolve NOW, against the working directory the caller constructed with — a
    // later chdir must never re-point an already-constructed store. See the class doc.
    const absoluteRoot = resolve(root);
    this.#blobsDir = join(absoluteRoot, 'blobs');
    this.#tmpDir = join(absoluteRoot, 'tmp');
    this.#logPath = join(absoluteRoot, 'retrievals.log');
    const markerPath = join(absoluteRoot, 'format.json');
    // Validate before mutating: a directory carrying a marker this code does not
    // understand is refused with the directory exactly as it was found — no blobs/,
    // no tmp/, no staged temp file created inside someone else's layout.
    const existing = this.#readMarker(markerPath);
    if (existing !== undefined) this.#verifyMarker(markerPath, existing);
    mkdirSync(this.#blobsDir, { recursive: true });
    mkdirSync(this.#tmpDir, { recursive: true });
    this.#claimFormat(markerPath);
  }

  put(content: string): string {
    const hash = this.#hash(content);
    if (!KEY_PATTERN.test(hash)) {
      throw new SmeltError(
        `smelt: hash "${hash}" is not usable as a storage key — it must match ` +
          `${String(KEY_PATTERN)} so it can name a file inside blobs/ and nothing else.`,
      );
    }
    const existing = this.#readBlob(hash);
    if (existing !== undefined) {
      // Verify the stored bytes before comparing: a damaged blob is corruption, not a
      // collision. Only intact bytes that still differ earn HashCollisionError.
      if (this.#hash(existing) !== hash) throw new StoreCorruptionError(hash);
      if (existing !== content) throw new HashCollisionError(hash);
      return hash;
    }
    const tmpPath = this.#writeTemp(content);
    try {
      // link(2) is the atomic, no-clobber publish: it fails with EEXIST rather than
      // overwrite, so a concurrent writer can never silently replace someone's bytes.
      linkSync(tmpPath, join(this.#blobsDir, hash));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Another writer published this hash between our existence check and our link.
      // Same bytes: idempotent put, done. Damaged or vanished bytes: corruption — the
      // store was torn or edited outside smelt. Intact different bytes: a collision.
      const winner = this.#readBlob(hash);
      if (winner === undefined || this.#hash(winner) !== hash) {
        throw new StoreCorruptionError(hash);
      }
      if (winner !== content) throw new HashCollisionError(hash);
    } finally {
      unlinkSync(tmpPath);
    }
    fsyncDirBestEffort(this.#blobsDir);
    return hash;
  }

  peek(hash: string): string | undefined {
    const content = this.#readBlob(hash);
    if (content === undefined) return undefined;
    if (this.#hash(content) !== hash) throw new StoreCorruptionError(hash);
    return content;
  }

  retrieve(hash: string): string {
    const content = this.#readBlob(hash);
    if (content === undefined) {
      this.#appendLogCounting('miss', hash);
      throw new UnknownHashError(hash);
    }
    if (this.#hash(content) !== hash) {
      this.#appendLogCounting('corrupt', hash);
      throw new StoreCorruptionError(hash);
    }
    this.#appendLogCounting('hit', hash);
    return content;
  }

  has(hash: string): boolean {
    return this.#readBlob(hash) !== undefined;
  }

  /**
   * The five directly-observed counts, every one read off the disk — a scan of
   * `blobs/` plus a fold over `retrievals.log`. See {@link RawRetrieveCounters}; the
   * derived half of the stats comes from the shared `retrieveStats()`, never here.
   */
  rawCounters(): RawRetrieveCounters {
    let elisionsStored = 0;
    let bytesStored = 0;
    for (const entry of readdirSync(this.#blobsDir)) {
      if (!KEY_PATTERN.test(entry)) continue; // `.DS_Store` and friends are not blobs
      elisionsStored += 1;
      bytesStored += statSync(join(this.#blobsDir, entry)).size;
    }

    let retrieveCalls = 0;
    let misses = 0;
    const hits = new Set<string>();
    for (const line of this.#readLog().split('\n')) {
      const match = LOG_LINE.exec(line);
      if (match === null) continue; // a torn tail from a crash mid-append, or blank
      retrieveCalls += 1;
      if (match[1] === 'miss') misses += 1;
      else if (match[1] === 'hit') hits.add(JSON.parse(match[2]!) as string);
    }

    return { elisionsStored, bytesStored, retrieveCalls, uniqueRetrieved: hits.size, misses };
  }

  stats(): RetrieveStats {
    return retrieveStats(this.rawCounters());
  }

  /** The blob's exact content, or `undefined` when no such blob is stored. */
  #readBlob(hash: string): string | undefined {
    if (!KEY_PATTERN.test(hash)) return undefined; // never a path component
    try {
      return readFileSync(join(this.#blobsDir, hash), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Write content to a unique file in `tmp/`, fsynced, and return its path. */
  #writeTemp(content: string): string {
    const tmpPath = join(this.#tmpDir, `${String(process.pid)}-${randomBytes(8).toString('hex')}`);
    const fd = openSync(tmpPath, 'wx');
    try {
      // writeSync may write fewer bytes than asked; loop, or a short write would be
      // fsynced and published under the full content's hash as a torn blob.
      const bytes = Buffer.from(content, 'utf8');
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return tmpPath;
  }

  /**
   * A journal append on the `retrieve()` path — counting, not custody. A failure here
   * must never decide whether the caller gets its verified bytes (or its true error),
   * so it is caught and surfaced as a distinct `process.emitWarning` — see the class
   * doc, and the read-only-journal case in `test/store-dir.test.ts`.
   */
  #appendLogCounting(kind: 'hit' | 'miss' | 'corrupt', hash: string): void {
    try {
      this.#appendLog(kind, hash);
    } catch (error) {
      process.emitWarning(
        `smelt: could not journal a "${kind}" for hash "${hash}" in ${this.#logPath} ` +
          `(${error instanceof Error ? error.message : String(error)}). The retrieval ` +
          `itself is unaffected, but this count is lost — retrieveCalls and ` +
          `expansionRate now UNDER-report until the journal is writable again.`,
        'SmeltCounterWriteFailure',
      );
    }
  }

  /**
   * One durable journal line. The hash is JSON-encoded because `retrieve()` takes it
   * from the model verbatim — a hash containing a newline must not forge a second line.
   * The record starts with its own newline so a torn tail from an earlier crash — a
   * partial record with no trailing newline — can never bleed into this one: the tear
   * stays on its own line and is skipped by `stats()`, as blank lines are.
   */
  #appendLog(kind: 'hit' | 'miss' | 'corrupt', hash: string): void {
    const fd = openSync(this.#logPath, 'a');
    try {
      const record = Buffer.from(`\n${kind} ${JSON.stringify(hash)}\n`, 'utf8');
      let written = 0;
      while (written < record.length) {
        written += writeSync(fd, record, written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  #readLog(): string {
    try {
      return readFileSync(this.#logPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  /**
   * Write the format marker if this directory has none, or verify the one it has.
   * Creation is atomic (write to `tmp/`, then `link`), so a concurrent creator never
   * observes a half-written marker. The constructor pre-verified any pre-existing
   * marker; the verify here catches only a concurrent creator's claim.
   */
  #claimFormat(markerPath: string): void {
    const claim = (): string | undefined => {
      const body = `${JSON.stringify({
        format: DIRECTORY_STORE_FORMAT,
        version: DIRECTORY_STORE_VERSION,
      })}\n`;
      const tmpPath = this.#writeTemp(body);
      try {
        linkSync(tmpPath, markerPath);
        return undefined; // claimed by us; nothing to verify
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return readFileSync(markerPath, 'utf8');
      } finally {
        unlinkSync(tmpPath);
      }
    };

    const existing = claim();
    if (existing === undefined) return;
    this.#verifyMarker(markerPath, existing);
  }

  /** The marker's body, or `undefined` when the directory carries none. */
  #readMarker(markerPath: string): string | undefined {
    try {
      return readFileSync(markerPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Refuse a marker this version of smelt does not understand. */
  #verifyMarker(markerPath: string, existing: string): void {
    let parsed: { format?: unknown; version?: unknown };
    try {
      parsed = JSON.parse(existing) as { format?: unknown; version?: unknown };
    } catch {
      throw new StoreFormatError(
        `smelt: "${markerPath}" is not parseable JSON, so this directory cannot be ` +
          `trusted as an elision store. Refusing to read or write it.`,
      );
    }
    if (parsed.format !== DIRECTORY_STORE_FORMAT || parsed.version !== DIRECTORY_STORE_VERSION) {
      throw new StoreFormatError(
        `smelt: "${markerPath}" declares format ${JSON.stringify(parsed.format)} ` +
          `version ${JSON.stringify(parsed.version)}; this code understands ` +
          `"${DIRECTORY_STORE_FORMAT}" version ${String(DIRECTORY_STORE_VERSION)}. ` +
          `Refusing to reinterpret someone else's layout.`,
      );
    }
  }
}

/**
 * Flush the directory entry after a publish, so the *name* survives a crash as well as
 * the bytes. Where the platform refuses to fsync a directory (Windows does), the publish
 * is still atomic — only the durability of the directory entry falls back to the OS's
 * own schedule. Only that refusal is swallowed: a real I/O failure (`EIO`) propagates,
 * because "the disk could not flush" must never be reported as a successful put.
 */
function fsyncDirBestEffort(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return; // the platform refuses to even open a directory for reading (Windows)
  }
  try {
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EINVAL/ENOTSUP/EPERM/EBADF: the platform refuses to fsync a directory — see the
    // doc comment. Anything else (EIO above all) is a genuine write failure.
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EBADF') {
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}
