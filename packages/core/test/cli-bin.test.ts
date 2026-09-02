import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT } from '../src/cli/run.ts';

import { packageRoot } from './guards/_source.ts';

/**
 * The BUILT binary, spawned as a real subprocess — the claims no in-process suite can
 * make.
 *
 * Two of the ugliest pre-release bugs were invisible to `runCli` tests precisely
 * because they lived in the process boundary:
 *
 *  - **The slow pipe.** Touching `process.stdin` (even reading `.isTTY`) flips fd 0
 *    into non-blocking mode, so `readFileSync(0)` threw `EAGAIN` whenever the
 *    producer was slower than Node's startup — `(sleep 1; echo hi) | smelt` exited 4.
 *    An in-process fake stdin can never reproduce that; only a real pipe with a
 *    deliberately delayed writer can.
 *  - **require(esm).** Whether `require('@smeltjs/core')` works is a property of the
 *    built package's manifest plus Node's loader, not of any source file — so it is
 *    asserted here by a spawned CommonJS child resolving the real `dist/`.
 *
 * These tests need `dist/` — `pnpm verify` builds before testing. If this fails with
 * "binary not built", run `pnpm build` first.
 */

const binPath = join(packageRoot(), 'dist', 'cli', 'bin.js');

interface Finished {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawn the built bin; `stdin` writes with `delayMs`, then the stream ends. */
function runBin(
  args: readonly string[],
  stdin?: { readonly bytes: Uint8Array; readonly delayMs: number },
): Promise<Finished> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    if (stdin === undefined) {
      child.stdin.end();
    } else {
      setTimeout(() => {
        child.stdin.end(Buffer.from(stdin.bytes));
      }, stdin.delayMs);
    }
  });
}

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'smelt-bin-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('the built binary, as a real process', () => {
  it('is built (these tests are about dist/, not src/)', () => {
    expect(
      existsSync(binPath),
      `binary not built at ${binPath} — run \`pnpm build\` first (\`pnpm verify\` does)`,
    ).toBe(true);
  });

  it('survives a producer slower than node startup — the EAGAIN pipe', async () => {
    // The audit's exact repro shape: `(sleep 1; echo hi) | smelt --budget 100`.
    // 750ms is comfortably past Node startup, so fd 0 has no bytes ready when the
    // CLI reads it; with fd 0 accidentally non-blocking this exits 4 with EAGAIN.
    const { code, stdout, stderr } = await runBin(['--budget', '100'], {
      bytes: Buffer.from('hi\n', 'utf8'),
      delayMs: 750,
    });
    expect(stderr).not.toContain('EAGAIN');
    expect(code).toBe(EXIT.ok);
    expect(stdout).toBe('hi\n');
  }, 15_000);

  it('refuses non-UTF-8 stdin, naming the first bad offset, instead of mangling to U+FFFD', async () => {
    const { code, stdout, stderr } = await runBin(['--budget', '100'], {
      bytes: Buffer.from([0x68, 0x69, 0xff, 0x0a]), // "hi", one invalid byte, newline
      delayMs: 0,
    });
    expect(code).toBe(EXIT.refused);
    expect(stdout).toBe('');
    expect(stderr).toContain('not valid UTF-8');
    expect(stderr).toContain('offset 2');
  }, 15_000);

  it('accepts multi-byte UTF-8 exactly (the validator must not over-refuse)', async () => {
    const text = 'naïve — 統一 🙂 done\n';
    const { code, stdout } = await runBin(['--budget', '4000'], {
      bytes: Buffer.from(text, 'utf8'),
      delayMs: 0,
    });
    expect(code).toBe(EXIT.ok);
    expect(stdout).toBe(text);
  }, 15_000);

  it('prints the manifest version', async () => {
    const { code, stdout } = await runBin(['--version']);
    expect(code).toBe(EXIT.ok);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  }, 15_000);

  it('smelt map runs from the built binary: map on stdout, report on stderr, exit 0', async () => {
    // The subcommand smoke case: everything else about `map` is proven in-process
    // (test/cli-map.test.ts, test/guards/repo-map.test.ts); this asserts the shipped
    // executable actually routes the subcommand and keeps the two streams apart.
    const fixtureRoot = join(packageRoot(), 'test', 'fixtures', 'repomap-repo');
    const { code, stdout, stderr } = await runBin(['map', fixtureRoot, '--budget', '10000']);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('readSettings');
    expect(stderr).toContain('smelt map  ');
    expect(stderr).toMatch(/bytes used [\d,]+ of 10,000 budget/);
  }, 15_000);
});

describe('the built package loads from CommonJS via require(esm)', () => {
  it('resolves through both the exports map and the node10 main field', () => {
    // A scratch node_modules with the real package symlinked under its published
    // name, so `require('@smeltjs/core')` exercises the exports map's `default`
    // condition — the exact resolution an installed CJS consumer performs. The
    // supported engines floor (^20.19 || >=22.12) is precisely the unflagged
    // require(esm) floor, so on every supported Node this must simply work.
    mkdirSync(join(scratch, 'node_modules', '@smeltjs'), { recursive: true });
    const linkPath = join(scratch, 'node_modules', '@smeltjs', 'core');
    if (!existsSync(linkPath)) symlinkSync(packageRoot(), linkPath);

    const childPath = join(scratch, 'require-check.cjs');
    writeFileSync(
      childPath,
      [
        "'use strict';",
        "const assert = require('node:assert');",
        '// 1. The published specifier, through the exports map (needs `default`).',
        "const byName = require('@smeltjs/core');",
        "assert.strictEqual(typeof byName.createSmelter, 'function');",
        '// 2. The package directory, through the `main` field (node10 resolution).',
        'const byDir = require(process.env.SMELT_PKG_ROOT);',
        "assert.strictEqual(typeof byDir.createSmelter, 'function');",
        'assert.strictEqual(byDir.createSmelter, byName.createSmelter);',
        "process.stdout.write('require-ok');",
      ].join('\n'),
    );

    const child = spawnSync(process.execPath, [childPath], {
      cwd: scratch,
      encoding: 'utf8',
      env: { ...process.env, SMELT_PKG_ROOT: packageRoot() },
    });
    expect(
      child.status,
      `require(esm) of the built package failed:\n${child.stderr}${child.stdout}`,
    ).toBe(0);
    expect(child.stdout).toBe('require-ok');
  }, 15_000);
});
