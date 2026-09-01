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
import { join } from 'node:path';
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
 */
export class DirectoryElisionStore implements ElisionStore {
  readonly #blobsDir: string;
  readonly #tmpDir: string;
  readonly #logPath: string;
  readonly #hash: (content: string) => string;

  constructor(root: string, options: DirectoryElisionStoreOptions = {}) {
    this.#hash = options.hash ?? contentHash;
    this.#blobsDir = join(root, 'blobs');
    this.#tmpDir = join(root, 'tmp');
    this.#logPath = join(root, 'retrievals.log');
    mkdirSync(this.#blobsDir, { recursive: true });
    mkdirSync(this.#tmpDir, { recursive: true });
    this.#claimFormat(join(root, 'format.json'));
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
      // Same bytes: idempotent put, done. Different bytes: a collision, refused loudly.
      const winner = this.#readBlob(hash);
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
      this.#appendLog('miss', hash);
      throw new UnknownHashError(hash);
    }
    if (this.#hash(content) !== hash) {
      this.#appendLog('corrupt', hash);
      throw new StoreCorruptionError(hash);
    }
    this.#appendLog('hit', hash);
    return content;
  }

  has(hash: string): boolean {
    return this.#readBlob(hash) !== undefined;
  }

  stats(): RetrieveStats {
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
    const uniqueRetrieved = hits.size;

    return {
      elisionsStored,
      bytesStored,
      retrieveCalls,
      uniqueRetrieved,
      misses,
      expansionRate: elisionsStored === 0 ? 0 : uniqueRetrieved / elisionsStored,
      allElisionsRetrieved: elisionsStored > 0 && uniqueRetrieved === elisionsStored,
    };
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
      writeSync(fd, Buffer.from(content, 'utf8'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return tmpPath;
  }

  /**
   * One durable journal line. The hash is JSON-encoded because `retrieve()` takes it
   * from the model verbatim — a hash containing a newline must not forge a second line.
   */
  #appendLog(kind: 'hit' | 'miss' | 'corrupt', hash: string): void {
    const fd = openSync(this.#logPath, 'a');
    try {
      writeSync(fd, `${kind} ${JSON.stringify(hash)}\n`);
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
   * observes a half-written marker.
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
 * own schedule.
 */
function fsyncDirBestEffort(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // See the doc comment: refusing platforms keep atomicity, not entry durability.
  } finally {
    closeSync(fd);
  }
}
