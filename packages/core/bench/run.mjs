#!/usr/bin/env node
/**
 * The measurement harness — HANDOFF Slice 3. This is the program that earns smelt
 * the right to state a number (Law 4: claim no number that has not been measured).
 *
 * Three tiers, per HANDOFF Decision 8:
 *
 *   tier 1  bytes + elision counts per case. Deterministic, offline, no key, and
 *           reproducible by a stranger from a fresh clone: `pnpm build && pnpm bench`.
 *           This is the default, and the only thing that runs without a key.
 *   tier 2  token counts via `/v1/messages/count_tokens` (free, needs
 *           ANTHROPIC_API_KEY). Runs only when the key is present. Every row names
 *           its model; a byte count is never converted to tokens with a fudge factor.
 *   tier 3  expansion rate from real model calls counting `smelt_retrieve`
 *           invocations. Paid, so it additionally requires the explicit `--tier3`
 *           flag; the retrieval log is written to `bench/tier3-log/` to be committed.
 *
 * Results are appended to `bench/RESULTS.md`. Rows are append-only — a re-run on a
 * newer model is a new row, never an edit.
 *
 * Network access lives only in `tier2.mjs` and `tier3.mjs`, which are imported
 * dynamically and only on their tiers — a tier-1 run never loads a module that can
 * reach the wire. The library under `src/` cannot reach any of this; bench/ sits
 * outside the zero-network guard's walk and outside the published tarball, and must
 * stay there.
 *
 * Zero dependencies: `node:` builtins plus the built `dist/` of this package.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  appendResults,
  renderTable,
  resultRow,
  tier3Aggregate,
  tier3Verdict,
  validateCases,
} from './lib.mjs';

const benchDir = dirname(fileURLToPath(import.meta.url));
const resultsPath = join(benchDir, 'RESULTS.md');
const distEntry = join(benchDir, '../dist/index.js');

const RESULTS_PREAMBLE = `# smelt bench — results

Measured by \`bench/run.mjs\` on the committed corpus (\`bench/corpus/\`,
\`bench/cases.json\`). Every row states what was measured, on which date, at which
corpus commit, under which tier — and, for token and retrieval rows, on which model,
because those numbers are model-specific. Rows are **append-only**: a re-run, or a
run on a newer model, adds rows and never edits one (HANDOFF Decision 8 — Claude's
tokenizer changed ~30% between generations, and an edit would rewrite history).

Units mean exactly what they say: \`bytes\` is UTF-8 bytes of the input and the
smelted output; \`tokens\` is Anthropic's \`/v1/messages/count_tokens\` for the text
as a single user message on the named model (tier 2); \`elisions retrieved\` is
distinct elisions the named model asked back via \`smelt_retrieve\` out of the
distinct elisions stored (tier 3), where retrieving everything is a LOSS. Nothing
here is extrapolated, rounded up, or converted between units.`;

function fail(message) {
  process.stderr.write(`bench: ${message}\n`);
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const wantTier3 = args.delete('--tier3');
if (args.size > 0) fail(`unknown arguments: ${[...args].join(' ')} (only --tier3 is accepted)`);

if (!existsSync(distEntry)) {
  fail('dist/ is missing — run `pnpm build` first. The harness measures the built library.');
}

// -- corpus provenance --------------------------------------------------------

const git = (argv) => spawnSync('git', argv, { cwd: benchDir, encoding: 'utf8' });

const dirty = git(['status', '--porcelain', '--', 'corpus', 'cases.json']);
if (dirty.status !== 0) fail('git status failed — the corpus commit cannot be established.');
if (dirty.stdout.trim() !== '') {
  fail(
    'bench/corpus or cases.json has uncommitted changes. A number measured against an ' +
      'uncommitted corpus names no commit and is not reproducible — commit first (Law 4).',
  );
}
const commitResult = git(['log', '-n', '1', '--format=%H', '--', 'corpus', 'cases.json']);
const corpusCommit = commitResult.stdout.trim().slice(0, 12);
if (commitResult.status !== 0 || corpusCommit === '') {
  fail('could not resolve the corpus commit — is bench/corpus committed?');
}

// -- load and validate the cases ---------------------------------------------

const manifest = JSON.parse(readFileSync(join(benchDir, 'cases.json'), 'utf8'));
const problems = validateCases(manifest, (file) => existsSync(join(benchDir, file)));
if (problems.length > 0) fail(`cases.json is invalid:\n  ${problems.join('\n  ')}`);

const { createSmelter } = await import(distEntry);
const date = new Date().toISOString().slice(0, 10);
const rows = [];
const tiersRun = [];

/** A fresh smelter and result for one case — each case gets its own store. */
async function smeltCase(benchCase) {
  const smelter = createSmelter({ strategy: benchCase.strategy });
  const text = readFileSync(join(benchDir, benchCase.file), 'utf8');
  const result = await smelter.smelt(text, {
    path: benchCase.path,
    focus: benchCase.focus,
    budgetBytes: benchCase.budgetBytes,
  });
  return { smelter, text, result };
}

const fingerprint = (result) =>
  JSON.stringify({
    inputBytes: result.inputBytes,
    outputBytes: result.outputBytes,
    text: result.text,
    elisions: result.elisions.map((e) => [e.hash, e.reason.rule, e.range.start, e.range.end]),
  });

// -- tier 1: bytes and elision counts (always) --------------------------------

tiersRun.push('1');
for (const benchCase of manifest.cases) {
  const first = await smeltCase(benchCase);
  const second = await smeltCase(benchCase);
  if (fingerprint(first.result) !== fingerprint(second.result)) {
    fail(`${benchCase.id}: two identical runs produced different plans — not deterministic.`);
  }
  const { result } = first;
  rows.push(
    resultRow({
      caseId: benchCase.id,
      tier: 1,
      date,
      corpusCommit,
      unit: 'bytes',
      input: result.inputBytes,
      output: result.outputBytes,
      elisions: result.elisions.length,
      note: `budget ${String(benchCase.budgetBytes)} B, ${result.planner}`,
    }),
  );
}

// -- tier 2: token counts, only with a key ------------------------------------

const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey !== undefined && apiKey !== '') {
  tiersRun.push('2');
  const model = process.env.SMELT_BENCH_MODEL ?? 'claude-opus-5';
  const { countTokens } = await import('./tier2.mjs');
  for (const benchCase of manifest.cases) {
    const { text, result } = await smeltCase(benchCase);
    const input = await countTokens({ apiKey, model, text });
    const output = await countTokens({ apiKey, model, text: result.text });
    rows.push(
      resultRow({
        caseId: benchCase.id,
        tier: 2,
        date,
        corpusCommit,
        model,
        unit: 'tokens',
        input,
        output,
        elisions: result.elisions.length,
        note: 'count_tokens, text as one user message',
      }),
    );
  }
} else {
  process.stderr.write('bench: ANTHROPIC_API_KEY not set — tier 2 (token counts) skipped.\n');
}

// -- tier 3: expansion rate, only with a key AND the explicit flag ------------

if (wantTier3) {
  if (apiKey === undefined || apiKey === '') fail('--tier3 needs ANTHROPIC_API_KEY.');
  tiersRun.push('3');
  const model = process.env.SMELT_BENCH_MODEL ?? 'claude-opus-5';
  const { measureExpansion } = await import('./tier3.mjs');
  const logDir = join(benchDir, 'tier3-log');
  mkdirSync(logDir, { recursive: true });
  const verdictInputs = [];
  for (const benchCase of manifest.cases) {
    const { smelter, result } = await smeltCase(benchCase);
    const log = await measureExpansion({
      apiKey,
      model,
      benchCase,
      smelter,
      smeltedText: result.text,
    });
    writeFileSync(join(logDir, `${benchCase.id}.json`), `${JSON.stringify(log, null, 2)}\n`);
    const verdict = tier3Verdict(log.stats);
    verdictInputs.push(log.stats);
    rows.push(
      resultRow({
        caseId: benchCase.id,
        tier: 3,
        date,
        corpusCommit,
        model,
        unit: 'elisions retrieved',
        input: log.stats.elisionsStored,
        output: log.stats.uniqueRetrieved,
        note:
          `expansion rate ${verdict.expansionRate.toFixed(2)}, ` +
          `${String(log.stats.retrieveCalls)} calls` +
          (verdict.loss ? ' — LOSS: the model retrieved everything back' : ''),
      }),
    );
  }
  rows.push(
    resultRow({
      caseId: 'ALL CASES',
      tier: 3,
      date,
      corpusCommit,
      model,
      unit: 'elisions retrieved',
      input: verdictInputs.reduce((sum, entry) => sum + entry.elisionsStored, 0),
      output: verdictInputs.reduce((sum, entry) => sum + entry.uniqueRetrieved, 0),
      note: `aggregate expansion rate ${tier3Aggregate(verdictInputs).toFixed(2)}`,
    }),
  );
  process.stderr.write(`bench: tier 3 retrieval logs written to ${logDir} — commit them.\n`);
}

// -- append to RESULTS.md -----------------------------------------------------

const section = `## run ${date} — tier ${tiersRun.join(' + ')} — corpus ${corpusCommit}\n\n${renderTable(rows)}`;
const existing = existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8') : RESULTS_PREAMBLE;
writeFileSync(resultsPath, appendResults(existing, section));
process.stderr.write(
  `bench: ${String(rows.length)} rows (tier ${tiersRun.join(' + ')}) appended to bench/RESULTS.md\n`,
);
process.stdout.write(`${renderTable(rows)}\n`);
