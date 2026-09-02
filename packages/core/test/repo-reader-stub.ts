import { relative, sep } from 'node:path';

import type { DirEntry, RepoReader } from '../src/repomap/reader.ts';

/**
 * A `RepoReader` over a table, and a log of everything the map asked it.
 *
 * The repo map used to reach for `node:fs` directly, so every test about the *walk*
 * had to materialise a real tree: a temp directory per case, real symlinks, real
 * permissions — and some cases (a reader whose `stat` resolves a symlink to its
 * target, a file that exists but cannot be read) are not portably expressible on a
 * real filesystem at all. With the reader as a seam, a tree is a literal and the
 * assertions can be about *what was touched*, not only about what came back.
 *
 * The log is the point. "Symlinks are never followed" and "nothing is written unless
 * a `cacheDir` was handed in" are claims about calls, so the tests count calls.
 */

/** One node of a stub tree, keyed in the table by its root-relative path. */
export type StubNode =
  /** A regular file with these bytes. */
  | { readonly kind: 'file'; readonly content: string | Buffer }
  /** A file the reader can see but cannot read: `read()` throws. */
  | { readonly kind: 'unreadable'; readonly reason: string }
  /**
   * A symlink — modelled by a **resolving** reader: its `stat` reports the target
   * (`isFile`) alongside `isSymlink`, and `read()` would hand back the target's
   * bytes. A walk that refuses links only because an `lstat` of one is neither file
   * nor directory would follow this reader straight out of the root; the map must
   * refuse it on `isSymlink` itself.
   */
  | { readonly kind: 'symlink'; readonly content: string }
  /** Neither file nor directory: a fifo, a socket, a device node. */
  | { readonly kind: 'other' };

/** One call the map made, in the order it made it. */
export interface RecordedCall {
  readonly op: 'list' | 'read' | 'stat';
  /** Root-relative, `/`-separated; `''` is the root itself. */
  readonly path: string;
}

export interface StubReader extends RepoReader {
  /** Every call, in order. */
  readonly calls: readonly RecordedCall[];
  /** Just the operations aimed at one root-relative path, in order. */
  opsFor(path: string): readonly RecordedCall['op'][];
}

/** The virtual root the stub trees hang under. Nothing needs to exist on disk. */
export const STUB_ROOT = '/stub-repo';

export function stubReader(
  tree: Readonly<Record<string, StubNode>>,
  root: string = STUB_ROOT,
): StubReader {
  const calls: RecordedCall[] = [];

  // Directories are implied by the paths above them: a tree literal states its
  // files, never its scaffolding.
  const directories = new Set<string>(['']);
  for (const path of Object.keys(tree)) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) directories.add(segments.slice(0, i).join('/'));
  }

  const toRelative = (path: string): string => {
    const rel = relative(root, path);
    return rel === '' ? '' : rel.split(sep).join('/');
  };

  return {
    calls,
    opsFor(path) {
      return calls.filter((call) => call.path === path).map((call) => call.op);
    },
    list(dir) {
      const rel = toRelative(dir);
      calls.push({ op: 'list', path: rel });
      if (!directories.has(rel)) throw new Error(`stub reader: ENOTDIR ${rel}`);
      const names = new Set<string>();
      for (const path of [...Object.keys(tree), ...directories]) {
        if (path !== '' && parentOf(path) === rel) names.add(nameOf(path));
      }
      // Deliberately *not* sorted: the map owns the sorted walk, and a stub that
      // pre-sorted would hide it.
      const entries: DirEntry[] = [...names].toReversed().map((name) => ({ name }));
      return entries;
    },
    read(path) {
      const rel = toRelative(path);
      calls.push({ op: 'read', path: rel });
      const node = tree[rel];
      if (node === undefined) throw new Error(`stub reader: ENOENT ${rel}`);
      if (node.kind === 'unreadable') throw new Error(`stub reader: ${node.reason} ${rel}`);
      if (node.kind === 'other') throw new Error(`stub reader: EINVAL ${rel}`);
      return node.kind === 'file' ? asBuffer(node.content) : Buffer.from(node.content, 'utf8');
    },
    stat(path) {
      const rel = toRelative(path);
      calls.push({ op: 'stat', path: rel });
      const node = tree[rel];
      if (node === undefined) {
        return directories.has(rel)
          ? { size: 0, isFile: false, isDirectory: true, isSymlink: false }
          : undefined;
      }
      switch (node.kind) {
        case 'file':
          return {
            size: asBuffer(node.content).byteLength,
            isFile: true,
            isDirectory: false,
            isSymlink: false,
          };
        case 'unreadable':
          return { size: 1, isFile: true, isDirectory: false, isSymlink: false };
        case 'symlink':
          // A resolving reader: it answers about the target, and says so.
          return {
            size: Buffer.byteLength(node.content, 'utf8'),
            isFile: true,
            isDirectory: false,
            isSymlink: true,
          };
        case 'other':
          return { size: 0, isFile: false, isDirectory: false, isSymlink: false };
      }
    },
  } satisfies StubReader;
}

function asBuffer(content: string | Buffer): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
}

/** The directory one root-relative path sits in; `''` for a top-level entry. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
