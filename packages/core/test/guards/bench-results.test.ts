import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { guardRoot, packageRoot, stripStringsAndComments } from './_source.ts';

/**
 * BENCH-RESULTS GUARD — Law 4, for the one place numbers are allowed to exist.
 *
 * Slice 3 built the measurement harness so smelt can state a number. That is also
 * the moment a Law 4 violation stops being hypothetical: a results file is exactly
 * where an unmeasured, unattributed, or extrapolated figure would land, and where a
 * network call could quietly creep out of its tier. Three claims are pinned here:
 *
 *  1. `bench/` is not shipped. The manifest's `files` list must never grow a bench
 *     entry — the harness is measurement equipment, not product, and its tier-2/3
 *     modules can reach the network, which must never ride along in the tarball.
 *  2. Every row in `bench/RESULTS.md` is a measurement: it names its date, corpus
 *     commit and tier, token/retrieval rows name their model (token counts are
 *     model-specific — HANDOFF Decision 8), byte rows name none (bytes belong to no
 *     model, and a model on a byte row would imply a conversion nobody performed).
 *     And the file contains no extrapolation vocabulary: no "up to", and never a
 *     cache-hit-rate figure — the exact unsupported claims Law 4 was written
 *     against.
 *  3. The harness touches the network only in `tier2.mjs` and `tier3.mjs`. Every
 *     other bench module — the runner, the pure lib, the corpus generator — must be
 *     incapable of it, so a tier-1 run is offline by construction, not by flag.
 *
 * Committed artefacts are read through `guardRoot()` (with a fallback to the real
 * package for files a mutation did not copy), so `pnpm mutate` can stale one file
 * at a time and watch each claim go red.
 */

/** A committed artefact: the mutated copy when the runner staled it, else the real one. */
function artifact(relative: string): string {
  const staled = join(guardRoot(), relative);
  return readFileSync(existsSync(staled) ? staled : join(packageRoot(), relative), 'utf8');
}

const DATA_ROW = /^\|(?<cells>.+)\|$/;

interface ResultsRow {
  readonly cells: readonly string[];
  readonly line: string;
}

/** Every data row in every table of RESULTS.md — header and separator rows dropped. */
function resultsRows(markdown: string): readonly ResultsRow[] {
  const rows: ResultsRow[] = [];
  for (const line of markdown.split('\n')) {
    const match = DATA_ROW.exec(line.trim());
    if (match?.groups === undefined) continue;
    const cells = match.groups['cells'].split('|').map((cell) => cell.trim());
    if (cells[0] === 'case') continue; // header
    if (cells.every((cell) => /^-+$/.test(cell))) continue; // separator
    rows.push({ cells, line });
  }
  return rows;
}

describe('bench honesty guard (Law 4 — the harness that states the numbers)', () => {
  it('never ships bench/ — the files list excludes it', () => {
    const manifest = JSON.parse(artifact('package.json')) as { files?: readonly string[] };
    expect(manifest.files, 'the manifest has no files list to check').toBeDefined();
    const shipped = (manifest.files ?? []).filter(
      (entry) => entry === 'bench' || entry.startsWith('bench/'),
    );
    expect(
      shipped,
      'bench/ is measurement equipment with network-capable tier-2/3 modules; it must never enter the tarball',
    ).toEqual([]);
  });

  it('actually found rows to check — an empty results table proves nothing', () => {
    expect(resultsRows(artifact('bench/RESULTS.md')).length).toBeGreaterThan(0);
  });

  it('every results row names its date, corpus commit and tier; token and retrieval rows name their model', () => {
    for (const { cells, line } of resultsRows(artifact('bench/RESULTS.md'))) {
      const [caseId, tier, date, commit, model, unit, input, output] = cells;
      expect(caseId, line).toBeTruthy();
      expect(tier, line).toMatch(/^tier [123]$/);
      expect(date, line).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(commit, line).toMatch(/^[0-9a-f]{7,40}$/);
      expect(unit, line).toBeTruthy();
      expect(input, line).toMatch(/^\d+$/);
      expect(output, line).toMatch(/^\d+$/);
      if (unit === 'bytes') {
        expect(model, `a byte row must not name a model (no conversion exists): ${line}`).toBe('—');
      } else {
        expect(
          model,
          `a ${String(unit)} row without its model is not a measurement: ${line}`,
        ).toMatch(/\S/);
        expect(model, line).not.toBe('—');
      }
    }
  });

  it('RESULTS.md contains no extrapolation vocabulary and no cache-hit-rate claim', () => {
    const results = artifact('bench/RESULTS.md').toLowerCase();
    expect(results, '"up to" is extrapolation, not measurement').not.toMatch(/\bup to\b/);
    expect(
      results,
      'the cache-hit-rate figure is the claim Law 4 was written against',
    ).not.toContain('cache hit rate');
  });

  it('only tier2.mjs and tier3.mjs can reach the network', () => {
    const NETWORK_SHAPES = [/\bfetch\s*\(/, /node:https?\b/, /\bWebSocket\b/, /\bXMLHttpRequest\b/];
    const ALLOWED = new Set(['tier2.mjs', 'tier3.mjs']);
    const benchFiles = readdirSync(join(packageRoot(), 'bench'))
      .filter((entry) => entry.endsWith('.mjs'))
      .toSorted();
    expect(
      benchFiles.length,
      'found no bench modules — a vacuous scan proves nothing',
    ).toBeGreaterThan(0);
    expect(benchFiles).toContain('tier2.mjs');
    expect(benchFiles).toContain('tier3.mjs');

    for (const file of benchFiles) {
      if (ALLOWED.has(file)) continue;
      const source = stripStringsAndComments(artifact(`bench/${file}`));
      for (const shape of NETWORK_SHAPES) {
        expect(
          shape.test(source),
          `bench/${file} matches ${String(shape)} — network access belongs only in tier2.mjs/tier3.mjs, ` +
            'so that a tier-1 run is offline by construction',
        ).toBe(false);
      }
    }
  });
});
