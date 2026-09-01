import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { contentHash } from '../src/hash.ts';
import { DirectoryElisionStore } from '../src/store-dir.ts';

/**
 * Concurrency, with two REAL processes — not two promises.
 *
 * Two interleaved promises share one event loop and never actually race on the
 * filesystem, so they cannot prove the property that matters: that a second *process*
 * writing the same directory at the same time corrupts nothing. So this test spawns two
 * `node` subprocesses that hammer one store directory simultaneously — both putting the
 * same shared blobs (to force the atomic-publish race) and each putting and retrieving
 * private ones — then audits the directory from the parent with the real store.
 *
 * The subprocesses run the real implementation: `src/store-dir.ts` and the modules it
 * imports, emitted type-erased by this repo's own `tsc` into a scratch directory —
 * because the supported engine range (^20.19 || >=22.12) includes Node versions that
 * cannot run TypeScript directly.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const tscBin = fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url));

/** Emit the store and its imports as plain ESM for `node`; return the emit directory. */
function emitStoreModule(scratch: string): string {
  const outDir = join(scratch, 'out');
  const tsconfigPath = join(scratch, 'tsconfig.json');
  writeFileSync(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        target: 'es2023',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        allowImportingTsExtensions: true,
        rewriteRelativeImportExtensions: true,
        verbatimModuleSyntax: true,
        types: [],
        skipLibCheck: true,
        noCheck: true,
        noEmit: false,
        outDir,
        rootDir: srcDir,
      },
      files: [join(srcDir, 'store-dir.ts')],
    }),
  );
  const emit = spawnSync(tscBin, ['-p', tsconfigPath], { encoding: 'utf8' });
  if (emit.status !== 0) {
    throw new Error(`tsc failed to emit the worker's modules: ${emit.stdout}${emit.stderr}`);
  }
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'module' }));
  return outDir;
}

const WORKER_SOURCE = `
import { DirectoryElisionStore } from './out/store-dir.js';

const [root, seed] = process.argv.slice(2);
const store = new DirectoryElisionStore(root);
const report = [];
for (let i = 0; i < 25; i += 1) {
  // Both workers put these exact bytes, concurrently: the atomic-publish race.
  const shared = 'shared blob ' + String(i) + ' — both workers write these exact bytes';
  const own = 'worker ' + seed + ' private blob ' + String(i) + ' with some padding bytes';
  const sharedHash = store.put(shared);
  const ownHash = store.put(own);
  if (store.retrieve(ownHash) !== own) throw new Error('retrieve returned wrong bytes');
  report.push({ sharedHash, shared, ownHash, own });
}
process.stdout.write(JSON.stringify(report));
`;

interface WorkerBlob {
  readonly sharedHash: string;
  readonly shared: string;
  readonly ownHash: string;
  readonly own: string;
}

function runWorker(
  workerPath: string,
  storeRoot: string,
  seed: string,
): Promise<readonly WorkerBlob[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [workerPath, storeRoot, seed], { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(JSON.parse(stdout) as readonly WorkerBlob[]);
      else rejectPromise(new Error(`worker ${seed} exited ${String(code)}: ${stderr}`));
    });
  });
}

describe('DirectoryElisionStore under two real concurrent processes', () => {
  it('two processes writing one directory corrupt nothing and lose no counter', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'smelt-two-process-'));
    roots.push(scratch);
    const storeRoot = join(scratch, 'store');
    const workerPath = join(scratch, 'worker.mjs');
    emitStoreModule(scratch);
    writeFileSync(workerPath, WORKER_SOURCE);

    // Launched together, unawaited until both are running: a genuine race, from the
    // concurrent creation of the store directory itself onward.
    const [a, b] = await Promise.all([
      runWorker(workerPath, storeRoot, 'A'),
      runWorker(workerPath, storeRoot, 'B'),
    ]);

    // Audit every blob file on disk: each must hash to its own name. A torn or
    // clobbered write would fail this for some file.
    const blobsDir = join(storeRoot, 'blobs');
    const blobFiles = readdirSync(blobsDir);
    for (const file of blobFiles) {
      expect(contentHash(readFileSync(join(blobsDir, file), 'utf8'))).toBe(file);
    }

    // 25 shared + 25 private each: 75 distinct blobs, every one still retrievable.
    const store = new DirectoryElisionStore(storeRoot);
    for (const blob of [...a, ...b]) {
      expect(store.peek(blob.sharedHash)).toBe(blob.shared);
      expect(store.peek(blob.ownHash)).toBe(blob.own);
    }

    // Counters merged across both processes: 25 successful retrieves per worker, none
    // lost to the concurrent appends — and all of it visible to this third process,
    // which never retrieved anything itself.
    const stats = store.stats();
    expect(blobFiles).toHaveLength(75);
    expect(stats.elisionsStored).toBe(75);
    expect(stats.retrieveCalls).toBe(50);
    expect(stats.uniqueRetrieved).toBe(50);
    expect(stats.misses).toBe(0);
    expect(stats.expansionRate).toBe(50 / 75);
    expect(stats.bytesStored).toBe(
      blobFiles.reduce((sum, file) => sum + statSync(join(blobsDir, file)).size, 0),
    );
  }, 60_000);
});
