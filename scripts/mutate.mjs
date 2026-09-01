#!/usr/bin/env node
/**
 * The mutation runner — smelt's answer to "how do you know that check works?"
 *
 * A check nobody has watched fail is not known to work. So every guard in this repo
 * ships with at least one *mutation*: a specific, minimal break in the source that the
 * guard must catch. This script copies `packages/core/src` to a scratch directory,
 * applies one mutation, points the guard at the copy via `SMELT_GUARD_SRC`, and
 * asserts the guard goes **red**. A mutation the guard survives is reported as a
 * failure of the *guard*, not of the mutation.
 *
 * It also runs every guard against the pristine tree first, because a guard that fails
 * on clean source proves nothing when it fails on broken source.
 *
 * Convention, for anyone adding a guard:
 *
 *   1. Import the library through `@guard/...` so the alias can be redirected.
 *   2. Add an entry here naming the guard, the exact source string to break, and why
 *      that break matters.
 *   3. Run `pnpm mutate`. If the guard survives, the guard is wrong.
 *
 * `find` must match exactly once. A mutation that silently no-ops because the source
 * moved is the same class of bug the guards exist to catch, so it is a hard error.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corePackage = join(repoRoot, 'packages/core');
const sourceDir = join(corePackage, 'src');
const scratchDir = join(repoRoot, '.mutants');

const GUARDS = [
  'test/guards/no-network.test.ts',
  'test/guards/reversibility.test.ts',
  'test/guards/expansion-counter.test.ts',
];

/** @type {{id: string, guard: string, file: string, find: string, replace: string, why: string}[]} */
const MUTATIONS = [
  {
    id: 'law1-node-https-import',
    guard: 'test/guards/no-network.test.ts',
    file: 'plan/lexical.ts',
    find: "import type { ElisionPlan, PlanInput, PlannedElision, Planner } from '../types.ts';",
    replace:
      "import 'node:https';\nimport type { ElisionPlan, PlanInput, PlannedElision, Planner } from '../types.ts';",
    why: 'a network transport imported directly into the elision path',
  },
  {
    id: 'law1-global-fetch',
    guard: 'test/guards/no-network.test.ts',
    file: 'store.ts',
    find: '  put(content: string): string {',
    replace: '  put(content: string): string {\n    void fetch;',
    why: 'a network-capable global referenced without any import at all',
  },
  {
    id: 'law1-unclassified-package',
    guard: 'test/guards/no-network.test.ts',
    file: 'retrieve.ts',
    find: "import type { ElisionStore, RetrieveTool } from './types.ts';",
    replace:
      "import 'some-package-nobody-vetted';\nimport type { ElisionStore, RetrieveTool } from './types.ts';",
    why: 'a dependency that matches no list — the case a forbidden-list alone misses',
  },
  {
    id: 'law1-remote-grammar-scheme',
    guard: 'test/guards/no-network.test.ts',
    file: 'net/policy.ts',
    find: "export const ALLOWED_URL_SCHEMES: readonly string[] = ['file:'];",
    replace: "export const ALLOWED_URL_SCHEMES: readonly string[] = ['file:', 'https:'];",
    why: 'widening the scheme allowlist so a grammar could be fetched over the wire',
  },
  {
    id: 'law3-marker-range-off-by-one',
    guard: 'test/guards/reversibility.test.ts',
    file: 'apply.ts',
    find: '      outputRange: { start: outputBytes, end: outputBytes + markerBuffer.length },',
    replace:
      '      outputRange: { start: outputBytes, end: outputBytes + markerBuffer.length - 1 },',
    why: 'off-by-one marker bookkeeping — reconstruct would return almost-right text',
  },
  {
    id: 'law3-elision-not-stored',
    guard: 'test/guards/reversibility.test.ts',
    file: 'apply.ts',
    find: '    const hash = store.put(removedText);',
    replace:
      '    const hash = removedText.length > 4096 ? store.put(removedText) : "0000000000000000";',
    why: 'a size threshold that quietly makes small elisions unrecoverable',
  },
  {
    id: 'counter-increment-dropped',
    guard: 'test/guards/expansion-counter.test.ts',
    file: 'store.ts',
    find: '    this.#retrieveCalls += 1;',
    replace: '    // this.#retrieveCalls += 1;',
    why: 'the expansion rate pinned at a flattering zero forever',
  },
];

function runGuard(guard, guardSrc) {
  return spawnSync('./node_modules/.bin/vitest', ['run', guard, '--reporter=dot'], {
    cwd: corePackage,
    env: { ...process.env, SMELT_GUARD_SRC: guardSrc },
    encoding: 'utf8',
  });
}

function firstFailureLine(output) {
  const line = output
    .split('\n')
    .find((l) => /AssertionError|Error:|×|✗/.test(l) && l.trim() !== '');
  return line === undefined ? '(no failure line captured)' : line.trim();
}

const results = [];
let failed = 0;

console.log('\n=== pristine source: every guard must be green ===\n');
for (const guard of GUARDS) {
  const run = runGuard(guard, sourceDir);
  const ok = run.status === 0;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${guard}`);
  if (!ok) console.log(run.stdout + run.stderr);
}

console.log('\n=== mutations: every guard must go red ===\n');
rmSync(scratchDir, { recursive: true, force: true });

for (const mutation of MUTATIONS) {
  const mutantSrc = join(scratchDir, mutation.id, 'src');
  mkdirSync(dirname(mutantSrc), { recursive: true });
  cpSync(sourceDir, mutantSrc, { recursive: true });

  const target = join(mutantSrc, mutation.file);
  const original = readFileSync(target, 'utf8');
  const occurrences = original.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    console.log(
      `  BROKEN  ${mutation.id}: its anchor matches ${occurrences} times in ` +
        `src/${mutation.file}, expected exactly 1. The source moved; fix the mutation.`,
    );
    failed += 1;
    continue;
  }
  writeFileSync(target, original.replace(mutation.find, mutation.replace));

  const run = runGuard(mutation.guard, mutantSrc);
  const caught = run.status !== 0;
  if (!caught) failed += 1;
  results.push({ mutation, caught, output: run.stdout + run.stderr });

  console.log(`  ${caught ? 'CAUGHT ' : 'SURVIVED'} ${mutation.id}`);
  console.log(`           mutation: ${mutation.why}`);
  console.log(`           guard:    ${mutation.guard}`);
  if (caught) {
    console.log(`           red on:   ${firstFailureLine(results.at(-1).output)}`);
  } else {
    console.log(
      '           the guard did NOT notice. That is a hole in the guard, not in the mutation.',
    );
  }
  console.log('');
}

rmSync(scratchDir, { recursive: true, force: true });

const caughtCount = results.filter((r) => r.caught).length;
console.log(
  `=== ${String(caughtCount)}/${String(MUTATIONS.length)} mutations caught across ` +
    `${String(GUARDS.length)} guards ===\n`,
);

if (failed > 0) {
  console.error('mutation testing failed. A guard that cannot go red is not a guard.\n');
  process.exit(1);
}
