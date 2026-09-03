import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GuardMutation } from './_mutations.ts';
import { guardRoot, packageRoot, repoRoot } from './_source.ts';

/**
 * SITE-FACTS GUARD — the marketing site may only say what the packages say.
 *
 * The site is a separate app in the same repository, and it had no dependency on the
 * packages it advertises. So it retyped them: two version strings, the harness tier
 * table, the guard tally, the grammar count. On 2026-09-03 the deployed page said
 * `@smeltjs/core v0.2.0 · @smeltjs/mcp v0.1.0` while 0.3.0 and 0.2.0 were on npm — a
 * pair that was never published. Nothing could have caught it: root `verify` filters
 * `./packages/**`, and the deploy workflow triggered on `site/**` alone, so a release
 * could not make the site red, rebuild it, or make it right.
 *
 * `site/scripts/facts-data.mjs` now generates `site/src/generated/facts.json` at build
 * time and the components import it. This guard makes the generator's promise
 * checkable:
 *
 *   1. the versions it emits are the two manifests', character for character — the
 *      site cannot advertise a release that does not exist;
 *   2. it refuses, rather than emitting a hole, when a source is missing or
 *      unparseable — asserted by running the real `renderFacts` against a doctored copy
 *      of the JSON sources, the way `third-party.test.ts` watches its own generator
 *      refuse an unattributed grammar;
 *   3. the recorded-at version beside the site's terminal transcript — the one version
 *      string deliberately NOT generated, because it is provenance and must keep naming
 *      the release the recording was made on — never names a version the packages have
 *      not reached.
 *
 * The core manifest is read through `guardRoot()`, so `pnpm mutate` can stale the copy
 * this guard reads and watch the comparison go red while the generator keeps reporting
 * what the real tree says.
 */

const GENERATOR = join(repoRoot(), 'site/scripts/facts-data.mjs');
const TOUR = join(repoRoot(), 'site/src/components/Tour.tsx');

interface Facts {
  readonly versions: { readonly core: string; readonly mcp: string };
  readonly tiers: readonly { readonly tier: string; readonly harnesses: readonly unknown[] }[];
  readonly structuralLanguages: readonly string[];
  readonly grammars: readonly string[];
  readonly guards: { readonly guards: number; readonly mutations: number };
}

/** What the generator emits right now — the real script, as a subprocess. */
function generated(): Facts {
  const run = spawnSync(process.execPath, [GENERATOR, '--print'], { encoding: 'utf8' });
  expect(
    run.status,
    `site/scripts/facts-data.mjs failed. It reads the built @smeltjs/core, so the ` +
      `package must be built first (\`pnpm build\`):\n${run.stderr}`,
  ).toBe(0);
  return JSON.parse(run.stdout) as Facts;
}

function versionIn(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

/** The core's own version — through `guardRoot()`, so a mutation can stale this copy. */
function coreVersion(): string {
  const staled = join(guardRoot(), 'package.json');
  return versionIn(existsSync(staled) ? staled : join(packageRoot(), 'package.json'));
}

const mcpVersion = (): string => versionIn(join(repoRoot(), 'packages/mcp/package.json'));

const parts = (value: string): readonly number[] => value.split('.').map(Number);

/** `1.2.3` → `[1, 2, 3]`, compared field by field. */
function order(a: string, b: string): number {
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

describe('the site states the packages, and nothing it made up', () => {
  it('the generated versions are the manifests, character for character', () => {
    const facts = generated();
    expect(
      facts.versions.core,
      'the site would advertise a @smeltjs/core version the manifest does not carry — ' +
        'the exact defect this generator exists to end',
    ).toBe(coreVersion());
    expect(
      facts.versions.mcp,
      'the site would advertise a @smeltjs/mcp version the manifest does not carry',
    ).toBe(mcpVersion());
    // The published *pair*, not two independent strings: the footer prints both.
    expect(`core ${facts.versions.core} · mcp ${facts.versions.mcp}`).toBe(
      `core ${coreVersion()} · mcp ${mcpVersion()}`,
    );
  });

  it('carries the registry facts the page renders, none of them empty', () => {
    const facts = generated();
    expect(facts.tiers.length, 'no tier rows — the harness table would render empty').toBe(3);
    expect(facts.tiers.every((tier) => tier.harnesses.length > 0)).toBe(true);
    expect(facts.structuralLanguages.length).toBeGreaterThanOrEqual(10);
    expect(facts.grammars.length).toBeGreaterThanOrEqual(10);
    expect(facts.guards.guards).toBeGreaterThanOrEqual(12);
    expect(facts.guards.mutations).toBeGreaterThan(facts.guards.guards);
  });

  it('refuses to generate when a source is missing or unparseable', () => {
    // The generator, pointed at a copy of the repository's JSON sources: sound first
    // (so the refusals below are the ones under test and not an accident of the
    // scratch tree), then with the tally emptied, mangled, and removed. It must throw
    // every time rather than emit a fact with a hole in it — a build that fails is the
    // point. Run in a subprocess, like the third-party generator's partition check.
    const scratch = join(packageRoot(), '.guard-scratch/site-facts');
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(join(scratch, 'packages/core'), { recursive: true });
    mkdirSync(join(scratch, 'packages/mcp'), { recursive: true });
    for (const manifest of ['packages/core/package.json', 'packages/mcp/package.json']) {
      cpSync(join(repoRoot(), manifest), join(scratch, manifest));
    }
    cpSync(join(repoRoot(), 'guards.json'), join(scratch, 'guards.json'));

    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import { rmSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const root = ${JSON.stringify(scratch)};
        const tally = join(root, 'guards.json');
        const { renderFacts } = await import(${JSON.stringify(GENERATOR)});
        const attempt = async (label) => {
          try {
            await renderFacts(root);
            console.log(label + ': NO THROW');
          } catch (error) {
            console.log(label + ': THREW: ' + error.message);
          }
        };
        await attempt('sound');
        writeFileSync(tally, '{ "guards": 0, "mutations": 0 }');
        await attempt('empty');
        writeFileSync(tally, 'not json at all');
        await attempt('mangled');
        rmSync(tally);
        await attempt('missing');
        `,
      ],
      { encoding: 'utf8', cwd: repoRoot() },
    );
    rmSync(scratch, { recursive: true, force: true });

    expect(run.status, `the refusal probe failed to run:\n${run.stderr}`).toBe(0);
    const lines = Object.fromEntries(
      run.stdout
        .split('\n')
        .filter((line) => line.includes(': '))
        .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
    );
    expect(
      lines['sound'],
      'the doctored copy is not a working root — the probe proves nothing',
    ).toBe('NO THROW');
    expect(
      lines['empty'],
      'a tally of zero guards is not a tally, and the site would print "0 mutations"',
    ).toMatch(/^THREW: .*guards\.json/);
    expect(lines['mangled'], 'an unparseable source must fail the build, not be skipped').toMatch(
      /^THREW: .*parseable/,
    );
    expect(lines['missing'], 'a missing source must fail the build, not default').toMatch(
      /^THREW: .*missing/,
    );
  });

  it("the tour's recorded-at version is a version the packages have reached", () => {
    // The one version string on the page that is deliberately not generated: it says
    // which release the committed terminal transcript was recorded from, and pointing
    // it at the current release would claim a run that never happened. What it may
    // never do is name a version that does not exist yet.
    const source = readFileSync(TOUR, 'utf8');
    const recorded = /const RECORDED = \{ version: '(?<version>[^']+)'/u.exec(source);
    expect(
      recorded?.groups?.['version'],
      'Tour.tsx no longer declares the version its transcript was recorded from — ' +
        'a terminal recording without provenance is a screenshot',
    ).toBeDefined();
    const version = recorded!.groups!['version']!;
    expect(
      order(version, coreVersion()) <= 0,
      `the tour says it was recorded on @smeltjs/core v${version}, which is ahead of the ` +
        `${coreVersion()} in the manifest — a recording from a release that does not exist`,
    ).toBe(true);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one and asserts this
 * file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'artifact',
    id: 'site-advertises-an-unpublished-version',
    file: 'package.json',
    find: '"version": "0.3.0",',
    replace: '"version": "0.9.0",',
    why: 'the released version and the advertised one disagreeing — exactly the state the deployed page was found in (v0.2.0 on the page while 0.3.0 was on npm), and which nothing in the repository could see, because the site retyped what the manifest says',
  },
];
