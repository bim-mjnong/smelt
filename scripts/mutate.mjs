#!/usr/bin/env node
/**
 * The mutation runner — smelt's answer to "how do you know that check works?"
 *
 * A check nobody has watched fail is not known to work. So every guard in this repo
 * ships with at least one *mutation*: a specific, minimal break in the source that the
 * guard must catch — and the mutations live **with their guard**: each
 * `test/guards/*.test.ts` exports `MUTATIONS: GuardMutation[]` beside the assertions
 * that must notice the break (`test/guards/_mutations.ts` holds the shape). This file
 * is only the runner: it discovers the guard files, extracts each one's mutations,
 * copies `packages/core/src` to a scratch directory, applies one mutation, points the
 * guard at the copy via `SMELT_GUARD_SRC`, and asserts the guard goes **red**. A
 * mutation the guard survives is reported as a failure of the *guard*, not of the
 * mutation — and the run ends with the real tally, counted from the guard files
 * themselves, never typed into prose (a drift check below holds the docs to that).
 *
 * It also runs every guard against the pristine tree first, because a guard that fails
 * on clean source proves nothing when it fails on broken source.
 *
 * Two kinds of mutation exist, because not every guard guards source code:
 *
 *   - `kind: 'src'` (the default) breaks a file under `packages/core/src`, and the guard
 *     is pointed at the broken copy via `SMELT_GUARD_SRC`.
 *   - `kind: 'artifact'` breaks a *committed artefact* under `packages/core` — a
 *     generated file, for instance — in a scratch root the guard reads via
 *     `SMELT_GUARD_ROOT`. Nothing in the working tree is touched either way, which
 *     matters: a mutation runner that edits tracked files and crashes leaves the repo
 *     broken, and the whole point is that a failure here is safe.
 *
 * Convention, for anyone adding a guard:
 *
 *   1. Import the library through `@guard/...` so the alias can be redirected, and read
 *      committed artefacts through `guardRoot()` so they can be too.
 *   2. Export `MUTATIONS: GuardMutation[]` from the guard file itself: the exact source
 *      string to break, and why that break matters, beside the assertions that must
 *      catch it. Entries are literal data — see `test/guards/_mutations.ts`.
 *   3. Run `pnpm mutate`. If the guard survives, the guard is wrong.
 *
 * `find` must match exactly once. A mutation that silently no-ops because the source
 * moved is the same class of bug the guards exist to catch, so it is a hard error.
 *
 * How the mutations get out of the guard files: the guards are TypeScript test modules
 * that call vitest's `describe` at import time, so they cannot be imported here — not
 * by any Node in the supported range (20.19 runs no TypeScript at all), and not after a
 * tsc emit either, because `describe` outside a vitest runner throws. Booting a whole
 * vitest just to read data would make the safety tool heavier than the suite it checks.
 * So the runner extracts each `MUTATIONS` array literal textually and lets **V8 parse
 * it**: the declaration anchor is the exact shape prettier enforces (and
 * `pnpm format:check` gates), and the literal is evaluated in an empty `node:vm`
 * sandbox — no hand-written string/escape parsing anywhere, and an entry that is not
 * literal data (an identifier, an import) fails loudly with the file named. Every
 * failure mode in this pipeline is a hard error naming the guard file; nothing no-ops.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corePackage = join(repoRoot, 'packages/core');
const sourceDir = join(corePackage, 'src');
const guardsDir = join(corePackage, 'test/guards');
const scratchDir = join(repoRoot, '.mutants');

function die(message) {
  console.error(`mutate: ${message}`);
  process.exit(1);
}

/**
 * Every guard file, discovered rather than listed — a new guard joins the pristine
 * check and the mutation run by existing. Files starting with `_` are shared
 * helpers (`_source.ts`, `_mutations.ts`), not guards.
 */
const GUARDS = readdirSync(guardsDir)
  .filter((entry) => entry.endsWith('.test.ts') && !entry.startsWith('_'))
  .toSorted()
  .map((entry) => `test/guards/${entry}`);
if (GUARDS.length === 0)
  die('no guard files found under test/guards — a vacuous run proves nothing');

/**
 * Extract one guard's MUTATIONS.
 *
 * The anchors are the exact declaration prettier produces (`export const MUTATIONS:
 * GuardMutation[] = [` … `\n];`), so they are as stable as the repo's own formatting
 * gate; V8 parses the literal itself inside an empty sandbox. Alongside the runtime
 * array, the `id:` property lines of the source region are collected for the fusion
 * check below.
 */
function extractMutations(guard) {
  const path = join(corePackage, guard);
  const source = readFileSync(path, 'utf8');

  const declaration = /^export const MUTATIONS: GuardMutation\[\] = \[$/m.exec(source);
  if (declaration === null) {
    die(
      `${guard} exports no MUTATIONS — every guard ships its breaks beside its ` +
        `assertions. Add \`export const MUTATIONS: GuardMutation[] = [ … ];\` ` +
        `(see test/guards/_mutations.ts), with at least one entry.`,
    );
  }
  const open = source.indexOf('[', declaration.index);
  const close = source.indexOf('\n];', open);
  if (close === -1) die(`${guard}: the MUTATIONS literal never closes with a top-level \`];\``);
  const literal = source.slice(open, close + 2); // `[` … `\n]`

  let mutations;
  try {
    // An empty sandbox: entries are literal data, so any identifier reference —
    // an import, a helper, a computed value — throws here, with the file named.
    mutations = runInNewContext(`(${literal})`, {}, { filename: `${guard}#MUTATIONS` });
  } catch (error) {
    die(
      `${guard}: MUTATIONS did not evaluate as literal data — ` +
        `${error instanceof Error ? error.message : String(error)}. Entries must be ` +
        `plain object literals of strings (concatenation with + is fine).`,
    );
  }
  if (!Array.isArray(mutations) || mutations.length === 0) {
    die(`${guard}: MUTATIONS must be a non-empty array`);
  }

  const sourceIds = [...literal.matchAll(/^ {4}id: '([^']+)',$/gm)].map((match) => match[1]);
  return { mutations, sourceIds };
}

/**
 * Self-check: refuse to run over malformed or fused MUTATIONS, in any guard.
 *
 * The trap is specific and has happened three times: a rebase merges two adjacent
 * object literals into one — the `},\n  {` between them collapses away — and
 * JavaScript accepts the result without a murmur: the duplicated keys are legal,
 * the later `id` wins, and one mutation silently stops running. A runner that
 * quietly runs n−1 of its n mutations is precisely the silent failure this file
 * exists to catch, so the check is structural, per guard file: every `id:` line in
 * that file's MUTATIONS source must correspond to exactly one runtime object, every
 * id must be globally unique, and every entry must carry the full GuardMutation
 * shape. Anything else is a hard error naming the file, before anything runs.
 * (In TypeScript a fused literal is also a duplicate-property type error — this
 * keeps the property even when the typechecker has not run.)
 */
function validateMutations(guard, { mutations, sourceIds }, seenIds) {
  const ALLOWED_KEYS = new Set(['id', 'file', 'find', 'replace', 'why', 'kind']);

  for (const [index, mutation] of mutations.entries()) {
    const label = () =>
      `${guard}: MUTATIONS[${String(index)}]` +
      (typeof mutation?.id === 'string' ? ` ("${mutation.id}")` : '');
    if (typeof mutation !== 'object' || mutation === null) die(`${label()} is not an object`);
    for (const key of Object.keys(mutation)) {
      if (!ALLOWED_KEYS.has(key)) die(`${label()} carries an unknown key "${key}"`);
    }
    for (const key of ['id', 'file', 'find', 'why']) {
      if (typeof mutation[key] !== 'string' || mutation[key] === '') {
        die(`${label()} needs a non-empty string \`${key}\``);
      }
    }
    if (typeof mutation.replace !== 'string') die(`${label()} needs a string \`replace\``);
    if (mutation.kind !== undefined && mutation.kind !== 'src' && mutation.kind !== 'artifact') {
      die(`${label()} has kind "${String(mutation.kind)}" — only 'src' and 'artifact' exist`);
    }
    if (seenIds.has(mutation.id)) {
      die(
        `mutation id "${mutation.id}" appears in both ${seenIds.get(mutation.id)} and ` +
          `${guard} — every id must be unique across all guards`,
      );
    }
    seenIds.set(mutation.id, guard);
  }

  if (sourceIds.length !== mutations.length) {
    // A fused object contributes two `id:` lines to the source but one object at
    // runtime, whose later id wins — so the id that vanished is the first source
    // id the runtime list no longer has, and its partner is the source id that
    // follows it inside the same fused literal.
    const runtimeSet = new Set(mutations.map((mutation) => mutation.id));
    const lost = sourceIds.find((id) => !runtimeSet.has(id));
    if (lost !== undefined) {
      const partner = sourceIds[sourceIds.indexOf(lost) + 1] ?? '(none — trailing id)';
      die(
        `${guard}: mutations "${lost}" and "${partner}" appear fused into one object — ` +
          `"${lost}"'s fields were silently overwritten and its mutation no longer runs. ` +
          `Restore the "},\\n  {" boundary between them.`,
      );
    }
    die(
      `${guard}: the source declares ${String(sourceIds.length)} id lines but ` +
        `${String(mutations.length)} mutation objects exist — two entries have merged ` +
        `or an id moved`,
    );
  }
}

const seenIds = new Map();
const MUTATIONS_BY_GUARD = GUARDS.map((guard) => {
  const extracted = extractMutations(guard);
  validateMutations(guard, extracted, seenIds);
  return { guard, mutations: extracted.mutations };
});
const totalMutations = MUTATIONS_BY_GUARD.reduce((sum, entry) => sum + entry.mutations.length, 0);

/**
 * Prose drift check: a mutation/guard count is rendered by this runner or verified
 * against it, never free-floating. Any "N mutations across M guards" phrase in the
 * docs must state the numbers this run just counted — otherwise the docs are claiming
 * a number nobody measured, which is this repository's own Law 4 pointed at itself.
 */
function assertProseCountsCurrent() {
  const PROSE = ['docs/HANDOFF.md', 'CONTRIBUTING.md', 'scripts/mutate.mjs'];
  const PATTERN = /(\d+)\s+mutations\s+across\s+(?:the\s+)?(\d+)\s+guards/gi;
  for (const relative of PROSE) {
    const text = readFileSync(join(repoRoot, relative), 'utf8');
    for (const match of text.matchAll(PATTERN)) {
      if (Number(match[1]) !== totalMutations || Number(match[2]) !== GUARDS.length) {
        die(
          `${relative} says "${match[0]}" but the guard files hold ` +
            `${String(totalMutations)} mutations across ${String(GUARDS.length)} guards. ` +
            `Update the prose, or drop the number and state the mechanism instead.`,
        );
      }
    }
  }
}

assertProseCountsCurrent();

function runGuard(guard, guardSrc, guardRoot = corePackage) {
  return spawnSync('./node_modules/.bin/vitest', ['run', guard, '--reporter=dot'], {
    cwd: corePackage,
    env: { ...process.env, SMELT_GUARD_SRC: guardSrc, SMELT_GUARD_ROOT: guardRoot },
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

for (const { guard, mutations } of MUTATIONS_BY_GUARD) {
  for (const mutation of mutations) {
    const kind = mutation.kind ?? 'src';
    const scratch = join(scratchDir, mutation.id);
    let guardSrc = sourceDir;
    let guardRoot = corePackage;
    let target;

    if (kind === 'src') {
      const mutantSrc = join(scratch, 'src');
      mkdirSync(dirname(mutantSrc), { recursive: true });
      cpSync(sourceDir, mutantSrc, { recursive: true });
      // The bundled grammars sit beside `src` in the real package, and the grammar
      // loader resolves them relative to its own module — so a mutant tree needs its own
      // copy, or a structural guard would go red for the wrong reason (a missing
      // grammar, not the mutation).
      const grammarsDir = join(corePackage, 'grammars');
      if (existsSync(grammarsDir)) {
        cpSync(grammarsDir, join(scratch, 'grammars'), { recursive: true });
      }
      guardSrc = mutantSrc;
      target = join(mutantSrc, mutation.file);
    } else {
      // Only the artefact is copied. The guard still reads the real manifest, the real
      // grammars and the real generator — the *committed* copy is the thing being staled.
      const mutantRoot = join(scratch, 'root');
      mkdirSync(mutantRoot, { recursive: true });
      cpSync(join(corePackage, mutation.file), join(mutantRoot, mutation.file));
      guardRoot = mutantRoot;
      target = join(mutantRoot, mutation.file);
    }

    const original = readFileSync(target, 'utf8');
    const occurrences = original.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      console.log(
        `  BROKEN  ${mutation.id}: its anchor matches ${occurrences} times in ` +
          `${kind === 'src' ? 'src/' : ''}${mutation.file}, expected exactly 1. The ` +
          `source moved; fix the mutation.`,
      );
      failed += 1;
      continue;
    }
    writeFileSync(target, original.replace(mutation.find, mutation.replace));

    const run = runGuard(guard, guardSrc, guardRoot);
    const caught = run.status !== 0;
    if (!caught) failed += 1;
    results.push({ mutation, caught, output: run.stdout + run.stderr });

    console.log(`  ${caught ? 'CAUGHT ' : 'SURVIVED'} ${mutation.id}`);
    console.log(`           mutation: ${mutation.why}`);
    console.log(`           guard:    ${guard}`);
    if (caught) {
      console.log(`           red on:   ${firstFailureLine(results.at(-1).output)}`);
    } else {
      console.log(
        '           the guard did NOT notice. That is a hole in the guard, not in the mutation.',
      );
    }
    console.log('');
  }
}

rmSync(scratchDir, { recursive: true, force: true });

const caughtCount = results.filter((r) => r.caught).length;
console.log(
  `=== ${String(caughtCount)}/${String(totalMutations)} mutations caught across ` +
    `${String(GUARDS.length)} guards ===\n`,
);

if (failed > 0) {
  console.error('mutation testing failed. A guard that cannot go red is not a guard.\n');
  process.exit(1);
}
