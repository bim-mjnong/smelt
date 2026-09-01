#!/usr/bin/env node
/**
 * The mutation runner — smelt's answer to "how do you know that check works?"
 *
 * A check nobody has watched fail is not known to work. So every guard in this repo
 * ships with at least one *mutation*: a specific, minimal break in the source that the
 * guard must catch. This script copies `packages/core/src` to a scratch directory,
 * applies one mutation, points the guard at the copy via `SMELT_GUARD_SRC`, and
 * asserts the guard goes **red**. Twenty-one mutations across eight guards; a mutation the
 * guard survives is reported as a failure of the *guard*, not of the mutation.
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
 *   2. Add an entry here naming the guard, the exact source string to break, and why
 *      that break matters.
 *   3. Run `pnpm mutate`. If the guard survives, the guard is wrong.
 *
 * `find` must match exactly once. A mutation that silently no-ops because the source
 * moved is the same class of bug the guards exist to catch, so it is a hard error.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  'test/guards/marker-format.test.ts',
  'test/guards/third-party.test.ts',
  'test/guards/persistent-store.test.ts',
  'test/guards/cache-hygiene.test.ts',
  'test/guards/structural.test.ts',
  'test/guards/bench-results.test.ts',
];

/**
 * @type {{id: string, guard: string, file: string, find: string, replace: string,
 *         why: string, kind?: 'src' | 'artifact'}[]}
 */
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
  {
    id: 'degenerate-outcome-never-fires',
    guard: 'test/guards/expansion-counter.test.ts',
    file: 'store.ts',
    find: '      allElisionsRetrieved: elisionsStored > 0 && uniqueRetrieved === elisionsStored,',
    replace: '      allElisionsRetrieved: false,',
    why: 'the one degenerate outcome smelt names, wired to a constant that can never fire',
  },
  {
    id: 'law1-cli-network-import',
    guard: 'test/guards/no-network.test.ts',
    file: 'cli/args.ts',
    find: "import { parseArgs } from 'node:util';",
    replace: "import 'node:https';\nimport { parseArgs } from 'node:util';",
    why: 'a transport in the CLI — the second front door, which a walk from index.ts alone would never scan',
  },
  {
    id: 'marker-format-silent-change',
    guard: 'test/guards/marker-format.test.ts',
    file: 'apply.ts',
    find: '  `<<smelt/${MARKER_FORMAT_VERSION}: ${explanation} (${String(bytes)}B) — retrieve("${hash}")>>`;',
    replace:
      '  `<<smelt/${MARKER_FORMAT_VERSION}: ${explanation} [${String(bytes)} bytes] retrieve=${hash}>>`;',
    why: 'the wire surface a model sees, reshaped without its version moving — worse output, no error anywhere',
  },
  {
    id: 'marker-version-not-frozen',
    guard: 'test/guards/marker-format.test.ts',
    file: 'apply.ts',
    find: "export const MARKER_FORMAT_VERSION = 'v1';",
    replace: "export const MARKER_FORMAT_VERSION = 'v2';",
    why: 'a new marker version with no frozen rendering — the format table must be total, not advisory',
  },
  {
    kind: 'artifact',
    id: 'third-party-attribution-dropped',
    guard: 'test/guards/third-party.test.ts',
    file: 'THIRD-PARTY.md',
    find: '| `tree-sitter-rust.wasm` |',
    replace: '| `tree-sitter-omitted.wasm` |',
    why: 'a bundled grammar losing its attribution in the committed notices — redistribution without a licence',
  },
  {
    id: 'law3-dir-store-verify-skipped',
    guard: 'test/guards/persistent-store.test.ts',
    file: 'store-dir.ts',
    find: "    if (this.#hash(content) !== hash) {\n      this.#appendLog('corrupt', hash);",
    replace: "    if (false) {\n      this.#appendLog('corrupt', hash);",
    why: 'verify-on-read disabled — a torn blob would be handed back as a faithful retrieval',
  },
  {
    id: 'law3-dir-store-counters-die-with-process',
    guard: 'test/guards/persistent-store.test.ts',
    file: 'store-dir.ts',
    find: "    this.#appendLog('hit', hash);",
    replace: "    // this.#appendLog('hit', hash);",
    why: 'the retrieval journal never written — the expansion rate resets to a flattering zero on every restart',
  },
  {
    id: 'cache-hygiene-rewrites-input',
    guard: 'test/guards/cache-hygiene.test.ts',
    file: 'cache/prefix.ts',
    find: '  const keys = Object.keys(record);',
    replace:
      '  const keys = Object.keys(record).toSorted();\n' +
      '  for (const key of keys) { const kept = record[key]; delete record[key]; record[key] = kept; }',
    why: 'the helpful in-place fix — sorting the caller\'s JSON keys for the cache — that "detect and warn, never rewrite" exists to refuse',
  },
  {
    id: 'cache-hit-rate-claimed',
    guard: 'test/guards/cache-hygiene.test.ts',
    file: 'cache/prefix.ts',
    find: 'export const ANTHROPIC_PROMPT_CACHE_FACTS = {',
    replace:
      '// smelt achieves a 90% cache hit rate\nexport const ANTHROPIC_PROMPT_CACHE_FACTS = {',
    why: "the original pitch's unsupported figure reappearing as a comment — the exact claim Law 4 was written against",
  },
  {
    id: 'structural-explanation-loses-kind',
    guard: 'test/guards/structural.test.ts',
    file: 'plan/structural.ts',
    find: '    return `collapsed ${String(total)} sibling ${countNoun(kind, total)}`;',
    replace: '    return `collapsed ${String(total)} lines`;',
    why: "the sibling-collapse explanation reduced to a line count — Law 2's whole point for this planner is naming kind and count from the parse tree",
  },
  {
    id: 'structural-silent-lexical-fallback',
    guard: 'test/guards/structural.test.ts',
    file: 'plan/structural.ts',
    find: '  throw new GrammarUnavailableError(\n    `smelt: structural planning covers ${named} in this ` +',
    replace:
      "  return 'typescript';\n  throw new GrammarUnavailableError(\n    `smelt: structural planning covers ${named} in this ` +",
    why: 'the no-fallback rule broken: an unmapped language quietly parsed as typescript instead of refused — structural/v1 output nobody asked the grammar to justify',
  },
  {
    id: 'structural-doc-comment-cut',
    guard: 'test/guards/structural.test.ts',
    file: 'plan/structural.ts',
    find: '  return (between.match(/\\n/g) ?? []).length <= 1;',
    replace: '  return false;',
    why: 'doc comments detached from their declarations, so a kept declaration silently loses its forty-line doc comment to the sibling collapse',
  },
  {
    id: 'structural-range-crosses-node-boundary',
    guard: 'test/guards/structural.test.ts',
    file: 'plan/structural.ts',
    find: '      range: { start, end },',
    replace: '      range: { start, end: end - 1 },',
    why: 'an elision range that stops one byte inside the last collapsed declaration — output that lies about where the parse tree was cut',
  },
  {
    id: 'structural-grammar-load-fallback',
    guard: 'test/guards/structural.test.ts',
    file: 'plan/structural.ts',
    find: '  const grammar = await loadGrammar(language);',
    replace:
      '  let grammar;\n' +
      '  try {\n' +
      '    grammar = await loadGrammar(language);\n' +
      '  } catch {\n' +
      "    const { planLexical } = await import('./lexical.ts');\n" +
      '    return { ...planLexical(input), planner: STRUCTURAL_PLANNER_ID };\n' +
      '  }',
    why: 'a failed grammar load quietly answered with line windows labelled structural/v1 — the exact undetectable fallback the no-fallback rule forbids',
  },
  {
    id: 'structural-error-node-called-declaration',
    guard: 'test/guards/structural.test.ts',
    file: 'plan/structural.ts',
    find: "  if (node.type === 'ERROR') return 'unparsed region';",
    replace: "  if (node.type === 'ERROR') return 'declaration';",
    why: 'an ERROR node labelled a declaration — the marker telling the model that broken text was code that parsed',
  },
  {
    id: 'structural-marker-cost-guessed',
    guard: 'test/guards/structural.test.ts',
    file: 'plan/structural.ts',
    find: '    if (cutBytes <= markerBytes) return;',
    replace: '    if (cutBytes < 128) return;',
    why: 'the profitability check reverted to a guessed constant — a mixed-kind marker can cost more than the cut it replaces, and the output grows',
  },
  {
    kind: 'artifact',
    id: 'bench-results-extrapolated-claim',
    guard: 'test/guards/bench-results.test.ts',
    file: 'bench/RESULTS.md',
    find: 'here is extrapolated, rounded up, or converted between units.',
    replace: 'here is extrapolated — savings of up to 94% are typical.',
    why: "the original pitch's extrapolation vocabulary landing in the one file that exists to hold measurements — Law 4's exact failure, in its most likely home",
  },
  {
    kind: 'artifact',
    id: 'bench-shipped-in-tarball',
    guard: 'test/guards/bench-results.test.ts',
    file: 'package.json',
    find: '  "files": [\n    "dist",',
    replace: '  "files": [\n    "dist",\n    "bench",',
    why: 'the network-capable measurement harness packed into the published tarball — bench/ is equipment, not product, and shipping it smuggles fetch() past the src-only zero-network walk',
  },
  {
    kind: 'artifact',
    id: 'bench-network-outside-tiers',
    guard: 'test/guards/bench-results.test.ts',
    file: 'bench/run.mjs',
    find: 'const { createSmelter } = await import(distEntry);',
    replace:
      "await fetch(new URL('https://example.invalid/telemetry'));\nconst { createSmelter } = await import(distEntry);",
    why: 'a network call in the default tier-1 path — the harness must be offline by construction outside tier2.mjs/tier3.mjs, or "reproducible offline by a stranger" is a flag away from false',
  },
  {
    kind: 'artifact',
    id: 'bench-subprocess-network-escape',
    guard: 'test/guards/bench-results.test.ts',
    file: 'bench/run.mjs',
    find: 'const { createSmelter } = await import(distEntry);',
    replace:
      "spawnSync('curl', ['https://example.invalid/telemetry']);\nconst { createSmelter } = await import(distEntry);",
    why: 'a subprocess reaching the network from the tier-1 path — no fetch, no node:http, so the network-shape scan stays green; only the spawn-only-git rule catches it',
    id: 'structural-new-language-dropped',
    guard: 'test/guards/structural.test.ts',
    file: 'plan/structural.ts',
    find: "const STRUCTURAL_LANGUAGES = ['typescript', 'tsx', 'rust', 'python', 'go'] as const;",
    replace: "const STRUCTURAL_LANGUAGES = ['typescript', 'tsx', 'rust', 'python'] as const;",
    why: 'a Slice 4 language quietly dropped from the planner — go callers would be refused while the docs still claim it',
  },
  {
    id: 'structural-rust-function-mislabelled',
    guard: 'test/guards/structural.test.ts',
    file: 'plan/structural.ts',
    find: "      function_item: 'function',",
    replace: "      function_item: 'declaration',",
    why: "rust's node kinds unmapped in the marker — `collapsed 2 sibling declarations` where the tree says functions, Law 2 decayed to a vaguer truth",
  },
  {
    id: 'structural-go-method-mislabelled',
    guard: 'test/guards/structural.test.ts',
    file: 'plan/structural.ts',
    find: "      method_declaration: 'method',",
    replace: "      method_declaration: 'declaration',",
    why: "go's method kind erased from the marker — a mixed collapse that can no longer say what it mixed",
  },
  {
    id: 'python-survivor-marker-not-a-comment',
    guard: 'test/guards/structural.test.ts',
    file: 'apply.ts',
    find: "  python: '# ',",
    replace: '',
    why: 'the python marker landing as a bare `<<smelt/v1 …>>` line — significant indentation lets the ERROR node swallow the neighbouring definitions, so the survivor stops being python at all',
  },
];

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

for (const mutation of MUTATIONS) {
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

  const run = runGuard(mutation.guard, guardSrc, guardRoot);
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
