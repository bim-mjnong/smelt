import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MEASURE_STUB_FILE, RERANK_STUB_FILE, runInit } from '../src/cli/init.ts';

/**
 * The generated stubs must typecheck against smelt's real exported types, under a
 * strict consumer's compiler settings — a stub that a consumer's first `tsc` rejects
 * is worse than no stub. The stubs are produced by actually running the wizard, so
 * this compiles exactly the bytes `smelt init` writes, not a copy of the template.
 *
 * TypeScript 7 ships no programmatic compiler API, so this drives the real `tsc`
 * binary over a consumer-shaped project: `@smeltjs/core` resolved via `paths` to this
 * package's own entrypoint.
 */

const packageRoot = resolve(import.meta.dirname, '..');
const tscBin = join(packageRoot, 'node_modules', '.bin', 'tsc');
let dir: string;

/** A strict consumer's project around `files`, compiled with the real tsc. */
function compile(projectDir: string, files: readonly string[]): { ok: boolean; output: string } {
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(projectDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'es2023',
        lib: ['es2023'],
        module: 'nodenext',
        moduleResolution: 'nodenext',
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        types: ['node'],
        typeRoots: [join(packageRoot, 'node_modules', '@types')],
        // TS 7 removed baseUrl; paths resolve relative to this tsconfig.
        paths: {
          '@smeltjs/core': [`./${relative(projectDir, join(packageRoot, 'src', 'index.ts'))}`],
        },
      },
      include: files,
    }),
  );
  const run = spawnSync(tscBin, ['-p', projectDir, '--pretty', 'false'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  return { ok: run.status === 0, output: run.stdout + run.stderr };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-stub-tsc-'));
  await runInit({
    // budget, store memory, strategy lexical, generate both stubs, confirm.
    input: Readable.from(['4000\n1\n1\n2\n2\nyes\n']),
    output: () => undefined,
    cwd: dir,
  });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the generated stubs typecheck against the library types', () => {
  it('smelt.measure.ts and smelt.rerank.ts compile clean under strict settings', () => {
    const { ok, output } = compile(dir, [MEASURE_STUB_FILE, RERANK_STUB_FILE]);
    expect(output.trim(), output).toBe('');
    expect(ok).toBe(true);
  });

  it('the compile harness itself can fail (no vacuous pass)', () => {
    const broken = join(dir, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(
      join(broken, 'broken.ts'),
      `import type { Measure } from '@smeltjs/core';\n` +
        `export const measure: Measure = { id: 'x' };\n`, // missing unit and count
    );
    const { ok, output } = compile(broken, ['broken.ts']);
    expect(ok).toBe(false);
    expect(output).toContain('Measure');
  });
});
