#!/usr/bin/env node
/**
 * Law 4 at build time: the numbers section renders ONLY what this script parses out of
 * `packages/core/bench/RESULTS.md` — the latest tier-1 run, verbatim rows. Nothing on
 * the page is typed by hand; a stale or missing RESULTS.md fails the build rather than
 * shipping an unmeasured number.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const resultsPath = join(here, '..', '..', 'packages', 'core', 'bench', 'RESULTS.md');
const outPath = join(here, '..', 'src', 'generated', 'bench.json');

const md = readFileSync(resultsPath, 'utf8');

// Sections are append-only: the last `## run …` heading is the latest run.
const headingRe = /^## run (\d{4}-\d{2}-\d{2}) — (tier \d) — corpus ([0-9a-f]+)\s*$/gm;
let heading;
for (const m of md.matchAll(headingRe)) heading = m;
if (!heading) {
  console.error('bench-data: no "## run …" heading found in RESULTS.md');
  process.exit(1);
}
const [, runDate, tier, corpusCommit] = heading;
const section = md.slice(heading.index + heading[0].length);
const sectionEnd = section.search(/^## /m);
const body = sectionEnd === -1 ? section : section.slice(0, sectionEnd);

const rows = [];
for (const line of body.split('\n')) {
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').map((c) => c.trim());
  // | case | tier | date | corpus commit | model | unit | input | output | elisions | note |
  if (cells.length < 11 || cells[1] === 'case' || /^-+$/.test(cells[1])) continue;
  const [, caseName, rowTier, date, corpus, model, unit, input, output, elisions, note] = cells;
  rows.push({
    case: caseName,
    tier: rowTier,
    date,
    corpusCommit: corpus,
    model: model === '—' ? null : model,
    unit,
    inputBytes: Number(input),
    outputBytes: Number(output),
    elisions: Number(elisions),
    note,
    overBudget: /OVER BUDGET/i.test(note),
  });
}

if (rows.length === 0) {
  console.error('bench-data: latest run section contains no table rows');
  process.exit(1);
}
for (const r of rows) {
  if (!Number.isFinite(r.inputBytes) || !Number.isFinite(r.outputBytes)) {
    console.error(`bench-data: non-numeric bytes in row "${r.case}"`);
    process.exit(1);
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ runDate, tier, corpusCommit, rows }, null, 2) + '\n');
console.log(
  `bench-data: ${rows.length} rows from run ${runDate} (${tier}, corpus ${corpusCommit}) → src/generated/bench.json`,
);
