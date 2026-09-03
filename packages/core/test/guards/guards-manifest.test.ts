import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GuardMutation } from './_mutations.ts';
import { guardRoot, repoRoot } from './_source.ts';

/**
 * GUARDS.JSON GUARD — the tally is measured, and the measurement is committed.
 *
 * "111 mutations across 23 guards" is a number, and Law 4 applies to it exactly as it
 * applies to a benchmark: state no number that has not been measured. It *was*
 * measured — `scripts/mutate.mjs` counts it every run — but it was then retyped into
 * four documents, and five commits in one day existed only to reconcile them after a
 * guard gained a mutation. The fourth copy, on the marketing site, was worded past the
 * regex that was supposed to catch that ("twenty-three guard suites, 111 mutations
 * across them"), which is the failure mode of every prose drift check: it holds the
 * sentences it recognises.
 *
 * So the tally is an artefact. `guards.json` at the repository root is written by the
 * runner (`pnpm generate:guards`), README.md and docs/ARCHITECTURE.md carry the
 * mechanism and a pointer instead of digits, and the site's build-time generator reads
 * the file. This guard is the freshness check: it runs the real runner in
 * `--print-guards` mode and fails if the committed file differs — the same shape as
 * `third-party.test.ts`, and for the same reason. A guard that re-implemented the
 * count could agree with itself while both were wrong.
 *
 * The artefact is repo-level (it counts every workspace package's guards, not this
 * package's), so it is read through `guardRoot()` with the repository root as the
 * fallback: `pnpm mutate` stales a copy of it and watches this go red.
 */

const MANIFEST = 'guards.json';
const RUNNER = join(repoRoot(), 'scripts/mutate.mjs');

interface GuardsManifest {
  readonly guards: number;
  readonly mutations: number;
  readonly byGuard: readonly { readonly guard: string; readonly count: number }[];
}

/** What the runner counts right now — the real script, as a subprocess. */
function counted(): { readonly text: string; readonly manifest: GuardsManifest } {
  const run = spawnSync(process.execPath, [RUNNER, '--print-guards'], { encoding: 'utf8' });
  expect(run.status, `the mutation runner failed to print the tally:\n${run.stderr}`).toBe(0);
  return { text: run.stdout, manifest: JSON.parse(run.stdout) as GuardsManifest };
}

/** The committed artefact: the staled copy when the runner made one, else the real file. */
function committed(): string {
  const staled = join(guardRoot(), MANIFEST);
  return readFileSync(existsSync(staled) ? staled : join(repoRoot(), MANIFEST), 'utf8');
}

describe('guards.json is the measured tally, and it is current', () => {
  it('matches what the mutation runner counts right now', () => {
    const { text } = counted();
    expect(
      committed(),
      `${MANIFEST} is stale. It is generated from the MUTATIONS each guard file exports ` +
        `— never edited by hand. Run \`pnpm generate:guards\` and commit the result.`,
    ).toBe(text);
  });

  it('is not vacuous: every discovered guard is listed, and the totals are its sum', () => {
    const { manifest } = counted();
    expect(
      manifest.guards,
      'fewer than a dozen guards discovered — the tally would be measuring a broken walk',
    ).toBeGreaterThanOrEqual(12);
    expect(manifest.byGuard.length).toBe(manifest.guards);
    expect(manifest.byGuard.reduce((sum, entry) => sum + entry.count, 0)).toBe(manifest.mutations);
    for (const entry of manifest.byGuard) {
      expect(entry.count, `${entry.guard} lists no mutations`).toBeGreaterThan(0);
      expect(
        existsSync(join(repoRoot(), entry.guard)),
        `${entry.guard} is counted but does not exist`,
      ).toBe(true);
    }
    // This file is one of them — the tally counts the guard that checks the tally.
    expect(manifest.byGuard.map((entry) => entry.guard)).toContain(
      'packages/core/test/guards/guards-manifest.test.ts',
    );
  });

  it('no document states the tally in digits of its own', () => {
    // The prose drift check this replaced held four documents to the counted number.
    // Now the number lives in one file, so the property is the opposite one: the
    // documents must not carry a copy at all.
    const PATTERN = /\d+\s+mutations\s+across\s+(?:the\s+)?\d+\s+guards/i;
    for (const relative of ['README.md', 'docs/ARCHITECTURE.md', 'CONTRIBUTING.md']) {
      const text = readFileSync(join(repoRoot(), relative), 'utf8');
      expect(
        PATTERN.exec(text)?.[0],
        `${relative} states the tally in digits again. It is measured in ${MANIFEST}; ` +
          `prose states the mechanism and points at the file, or it becomes the fifth ` +
          `copy somebody has to reconcile.`,
      ).toBeUndefined();
    }
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one and asserts this
 * file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'artifact',
    id: 'guards-manifest-stale',
    file: 'guards.json',
    find: '"mutations":',
    replace: '"mutations": 1,\n  "staleMutations":',
    why: 'the committed tally disagreeing with the guard files — the exact drift that used to be caught (when it was caught at all) by a regex over four documents, now a single artefact that can be watched going red',
  },
];
