import type { RepoMap } from '../repomap/map.ts';
import type { SmeltResult } from '../types.ts';

import { CLI_NAME } from './args.ts';

export interface ReportInput {
  readonly result: SmeltResult;
  /** What to call the input in the header: a path, or `'<stdin>'`. */
  readonly source: string;
  /** The budget the caller asked for, so the report can say when it was missed. */
  readonly budgetBytes: number;
  /** The exact text that was smelted. Used only to count lines inside each range. */
  readonly inputText: string;
}

/** Longest explanation printed in full before it gets an ellipsis. */
const EXPLANATION_WIDTH = 46;

/**
 * The report, for stderr.
 *
 * Every total here is read straight off the {@link SmeltResult} — `inputBytes`,
 * `outputBytes`, `elisions.length`. The CLI keeps no counters of its own, because two
 * pieces of code counting the same bytes is how a report ends up disagreeing with the
 * library it is reporting on, and the report is the thing a human believes.
 * `test/cli.test.ts` asserts the printed numbers equal the result's fields.
 */
export function formatReport({ result, source, budgetBytes, inputText }: ReportInput): string {
  const lines: string[] = [];

  lines.push([CLI_NAME, source, result.language, result.planner].join('  '));
  lines.push(
    `in ${group(result.inputBytes)} B → out ${group(result.outputBytes)} B   ` +
      `(${delta(result.inputBytes, result.outputBytes)}, ${count(result.elisions.length, 'elision')})`,
  );

  if (result.measured !== undefined) {
    const { input, output, unit, measure } = result.measured;
    lines.push(`in ${group(input)} → out ${group(output)} ${unit} (${measure})`);
  }

  if (result.outputBytes > budgetBytes) {
    lines.push('');
    lines.push(
      `OVER BUDGET  ${group(result.outputBytes)} B against a ${group(budgetBytes)} B budget ` +
        `— over by ${group(result.outputBytes - budgetBytes)} B.`,
    );
    lines.push('             The plan is reported as it came back. smelt did not cut the regions');
    lines.push('             you asked to keep in order to make a number look right.');
  }

  if (result.elisions.length === 0) {
    lines.push('');
    lines.push('  nothing elided — the input already fits, or every run was too small to');
    lines.push('  be worth a marker (a marker that costs more than the lines it replaces');
    lines.push('  makes the output bigger).');
    return `${lines.join('\n')}\n`;
  }

  const rows = result.elisions.map((elision) => ({
    rule: elision.reason.rule,
    lines: String(lineSpan(inputText, elision.range.start, elision.range.end)),
    bytes: group(elision.bytes),
    hash: elision.hash,
    explanation: clip(elision.reason.explanation, EXPLANATION_WIDTH),
  }));

  const ruleWidth = width(
    'rule',
    rows.map((row) => row.rule),
  );
  const linesWidth = width(
    'lines',
    rows.map((row) => row.lines),
  );
  const bytesWidth = width(
    'bytes',
    rows.map((row) => row.bytes),
  );
  const hashWidth = width(
    'hash',
    rows.map((row) => row.hash),
  );

  lines.push('');
  lines.push(
    `  ${'rule'.padEnd(ruleWidth)}  ${'lines'.padStart(linesWidth)}  ` +
      `${'bytes'.padStart(bytesWidth)}  ${'hash'.padEnd(hashWidth)}  explanation`,
  );
  for (const row of rows) {
    lines.push(
      `  ${row.rule.padEnd(ruleWidth)}  ${row.lines.padStart(linesWidth)}  ` +
        `${row.bytes.padStart(bytesWidth)}  ${row.hash.padEnd(hashWidth)}  ${row.explanation}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

/** What `smelt map` prints to stderr. */
export interface MapReportInput {
  readonly map: RepoMap;
  /** The directory named on the command line, exactly as the user wrote it. */
  readonly source: string;
  /**
   * Where the budget came from — the `ResolvedMapRun.budgetSource` receipt, printed
   * beside the budget so a surprising number can be traced to the flag or the config
   * file that set it without re-deriving the precedence by hand.
   */
  readonly budgetSource: 'flag' | 'config';
}

/**
 * The map report, for stderr — same law as {@link formatReport}: every number is
 * read straight off the {@link RepoMap} the library returned. In particular the
 * "bytes used" figure is `map.outputBytes`, which the library measured off the
 * rendered text — the CLI counts nothing itself, because a report that keeps its
 * own tally is a report that can disagree with the map it describes.
 * `test/guards/repo-map.test.ts` asserts the printed figure equals the actual byte
 * length of what landed on stdout, and a mutation proves the assertion can go red.
 */
export function formatMapReport({ map, source, budgetSource }: MapReportInput): string {
  const lines: string[] = [];

  lines.push([`${CLI_NAME} map`, source, map.id].join('  '));
  lines.push(
    `files scanned ${group(map.filesScanned)}` +
      (map.binarySkipped === 0 ? '' : ` (${count(map.binarySkipped, 'binary file')} skipped)`) +
      `   symbols ranked ${group(map.definitionsTotal)}`,
  );
  lines.push(
    `included ${group(map.entries.length)} of ${group(map.definitionsTotal)} symbols` +
      (map.pathOnlyTotal === 0
        ? ''
        : ` + ${group(map.pathOnly.length)} of ${group(map.pathOnlyTotal)} path-only files`),
  );
  lines.push(
    `bytes used ${group(map.outputBytes)} of ${group(map.budgetBytes)} budget (${budgetSource}) ` +
      `— the map fits itself to the budget by construction, so there is no over-budget exit`,
  );

  if (map.cache !== undefined) {
    lines.push(
      `cache  ${count(map.cache.hits, 'hit')}, ${count(map.cache.misses, 'miss', 'es')}, ` +
        `${group(map.cache.discarded)} discarded`,
    );
  }
  for (const warning of map.warnings) {
    lines.push(`warning  ${warning.rule}: ${warning.explanation}`);
  }

  return `${lines.join('\n')}\n`;
}

/** How many lines a byte range covers in the input. Derived, never tallied separately. */
function lineSpan(text: string, start: number, end: number): number {
  const slice = Buffer.from(text, 'utf8').subarray(start, end).toString('utf8');
  return slice.split('\n').length;
}

function width(header: string, values: readonly string[]): number {
  return values.reduce((widest, value) => Math.max(widest, value.length), header.length);
}

/** Thousands separators without pulling in ICU, so the output is identical everywhere. */
function group(n: number): string {
  const digits = String(Math.abs(Math.trunc(n)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${grouped}` : grouped;
}

function delta(inputBytes: number, outputBytes: number): string {
  if (inputBytes === 0) return 'empty input';
  const percent = ((outputBytes - inputBytes) / inputBytes) * 100;
  const sign = percent > 0 ? '+' : '';
  return `${sign}${percent.toFixed(1)}%`;
}

function count(n: number, noun: string, pluralSuffix = 's'): string {
  return `${group(n)} ${noun}${n === 1 ? '' : pluralSuffix}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
