import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildRepoMap } from '../src/repomap/map.ts';
import type { RepoMapOptions } from '../src/repomap/map.ts';
import { nodeFsReader } from '../src/repomap/reader.ts';
import { STUB_ROOT, stubReader } from './repo-reader-stub.ts';
import type { StubNode } from './repo-reader-stub.ts';

/**
 * The repo map, read through a stub {@link RepoReader} instead of a real tree.
 *
 * Every case here was expensive before the seam existed: a temp directory, real
 * files, a real symlink, a real permission bit — or, for the two most interesting
 * ones, not portably expressible at all. Now the tree is a literal, so the awkward
 * shapes (an empty repo, one file, a NUL byte, a file that cannot be read, a symlink
 * whose stat resolves its target) are one table.
 *
 * The laws these cases touch — the symlink refusal and "nothing is written without a
 * `cacheDir`" — are pinned, with reader-call counting and a mutation, in
 * `test/guards/repo-map.test.ts`. This file is the behaviour around them.
 */

const BUDGET = 10_000;

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

const FILE = (content: string): StubNode => ({ kind: 'file', content });
const ONE_SYMBOL = 'export function onlySymbol(): number {\n  return 1;\n}\n';

interface ReaderCase {
  readonly name: string;
  readonly tree: Readonly<Record<string, StubNode>>;
  readonly options?: Partial<RepoMapOptions>;
  /** Entry names, in fill order — exactly these, so an extra symbol fails too. */
  readonly names: readonly string[];
  readonly filesScanned: number;
  readonly binarySkipped?: number;
  readonly pathOnly?: readonly string[];
  readonly text?: string;
  /** Root-relative paths whose bytes must never have been read. */
  readonly neverRead?: readonly string[];
}

const CASES: readonly ReaderCase[] = [
  {
    name: 'an empty repo: an empty map, not a crash and not an invented line',
    tree: {},
    names: [],
    filesScanned: 0,
    text: '',
  },
  {
    name: 'a single-file repo: one symbol, one scanned file',
    tree: { 'only.ts': FILE(ONE_SYMBOL) },
    names: ['onlySymbol'],
    filesScanned: 1,
  },
  {
    name: 'a binary file: skipped and counted, never rendered',
    tree: {
      'only.ts': FILE(ONE_SYMBOL),
      'data.bin': { kind: 'file', content: Buffer.from([0x89, 0x00, 0x01, 0x02]) },
    },
    names: ['onlySymbol'],
    filesScanned: 2,
    binarySkipped: 1,
    pathOnly: [],
  },
  {
    name: 'a symlink out of the root: refused on isSymlink, its target never read',
    tree: {
      'real.ts': FILE('export function insideTheRoot(): number {\n  return 1;\n}\n'),
      'link.ts': {
        kind: 'symlink',
        content: 'export function leakedSecretToken(): number {\n  return 2;\n}\n',
      },
    },
    names: ['insideTheRoot'],
    filesScanned: 1,
    neverRead: ['link.ts'],
  },
  {
    name: 'a file with no definitions: listed by path, still visible',
    tree: { 'notes.md': FILE('# just prose\n') },
    names: [],
    filesScanned: 1,
    pathOnly: ['notes.md'],
  },
  {
    name: 'a fifo or socket: neither file nor directory, so neither walked nor read',
    tree: { 'only.ts': FILE(ONE_SYMBOL), 'pipe.ts': { kind: 'other' } },
    names: ['onlySymbol'],
    filesScanned: 1,
    neverRead: ['pipe.ts'],
  },
  {
    name: 'an ignored directory: never listed, never statted, never read',
    tree: {
      'src/only.ts': FILE(ONE_SYMBOL),
      'vendor/huge.ts': FILE('export function vendorSymbol(): number {\n  return 2;\n}\n'),
    },
    options: { ignore: ['vendor'] },
    names: ['onlySymbol'],
    filesScanned: 1,
    neverRead: ['vendor/huge.ts'],
  },
  {
    name: 'a nested tree: depth-first in sorted order, whatever order the reader lists',
    tree: {
      'z.ts': FILE('export function zebra(): number {\n  return 3;\n}\n'),
      'a/deep/b.ts': FILE('export function burrow(): number {\n  return 4;\n}\n'),
    },
    names: ['burrow', 'zebra'],
    filesScanned: 2,
  },
];

describe('the repo map over a stub reader', () => {
  it.each(CASES)('$name', async (testCase) => {
    const reader = stubReader(testCase.tree);
    const map = await buildRepoMap({
      root: STUB_ROOT,
      budgetBytes: BUDGET,
      reader,
      ...testCase.options,
    });

    expect(map.entries.map((entry) => entry.name)).toEqual(testCase.names);
    expect(map.filesScanned).toBe(testCase.filesScanned);
    if (testCase.binarySkipped !== undefined)
      expect(map.binarySkipped).toBe(testCase.binarySkipped);
    if (testCase.pathOnly !== undefined) {
      expect(map.pathOnly.map((entry) => entry.path)).toEqual(testCase.pathOnly);
    }
    if (testCase.text !== undefined) expect(map.text).toBe(testCase.text);
    for (const path of testCase.neverRead ?? []) {
      expect(reader.opsFor(path), `${path} was read`).not.toContain('read');
    }
    // No cacheDir was handed in, so no cache counts may be invented.
    expect(map.cache).toBeUndefined();
  });

  it('lets an unreadable file fail loudly — a silent skip would drop symbols', async () => {
    const reader = stubReader({
      'only.ts': FILE(ONE_SYMBOL),
      'locked.ts': { kind: 'unreadable', reason: 'EACCES' },
    });
    await expect(buildRepoMap({ root: STUB_ROOT, budgetBytes: BUDGET, reader })).rejects.toThrow(
      /EACCES/,
    );
  });

  it('re-extracts when the content behind a cache key changes', async () => {
    // The cache key is a content hash, so an edit is a miss by construction. Before
    // the seam this needed a temp tree and a rewrite on disk; now the "edit" is a
    // second reader over a different literal, against the same real cache directory.
    const cacheDir = scratch('smelt-reader-cache-');

    const before = await buildRepoMap({
      root: STUB_ROOT,
      budgetBytes: BUDGET,
      cacheDir,
      reader: stubReader({
        'only.ts': FILE('export function firstName(): number {\n  return 1;\n}\n'),
      }),
    });
    expect(before.entries.map((entry) => entry.name)).toEqual(['firstName']);
    expect(before.cache).toEqual({ hits: 0, misses: 1, discarded: 0 });

    const after = await buildRepoMap({
      root: STUB_ROOT,
      budgetBytes: BUDGET,
      cacheDir,
      reader: stubReader({
        'only.ts': FILE('export function secondName(): number {\n  return 2;\n}\n'),
      }),
    });
    expect(
      after.entries.map((entry) => entry.name),
      'the edited file was answered with the stale entry',
    ).toEqual(['secondName']);
    expect(after.cache).toEqual({ hits: 0, misses: 1, discarded: 0 });

    // And the unchanged content still hits: a miss on an edit, not a miss on everything.
    const again = await buildRepoMap({
      root: STUB_ROOT,
      budgetBytes: BUDGET,
      cacheDir,
      reader: stubReader({
        'only.ts': FILE('export function secondName(): number {\n  return 2;\n}\n'),
      }),
    });
    expect(again.cache).toEqual({ hits: 1, misses: 0, discarded: 0 });
  });

  it('defaults to node:fs, and that default has no writer on it', () => {
    // The seam is optional: a caller that never mentions a reader gets the same
    // three `node:fs` calls the map has always made — and no fourth one.
    expect(Object.keys(nodeFsReader()).toSorted()).toEqual(['list', 'read', 'stat']);
  });
});
