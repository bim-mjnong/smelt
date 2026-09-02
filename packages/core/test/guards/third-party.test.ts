import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WASM_BY_LANGUAGE } from '@guard/plan/grammar';

import { guardRoot, packageRoot, repoRoot } from './_source.ts';

/**
 * THIRD-PARTY GUARD — attribution that cannot rot.
 *
 * smelt ships the tree-sitter `.wasm` grammars **inside its own tarball**, which is what
 * makes "no native compilation, works offline" true and which makes smelt a
 * redistributor. Attribution is therefore required, and a hand-written notices file is
 * a promise that decays silently: a grammar gets added, the file does not, and nothing
 * anywhere fails. Downstream this is not academic — KLØDD ships in two app stores and
 * takes its licence screen text from here.
 *
 * So `THIRD-PARTY.md` is generated, and this guard regenerates it and fails if the
 * committed copy differs. It runs the real `scripts/generate-third-party.mjs` as a
 * subprocess rather than re-implementing it, because a guard that reimplements the thing
 * it guards can agree with itself while both are wrong.
 *
 * The generator's own totality checks — every bundled grammar attributed, every
 * attribution bundled — are asserted here too, by pointing it at a grammar set that is
 * missing an entry and watching it refuse.
 */

const GENERATOR = join(repoRoot(), 'scripts/generate-third-party.mjs');
const DOC = 'THIRD-PARTY.md';

function generate(): {
  readonly status: number | null;
  readonly out: string;
  readonly err: string;
} {
  const run = spawnSync(process.execPath, [GENERATOR, '--print'], { encoding: 'utf8' });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

describe('THIRD-PARTY.md is generated, current, and total', () => {
  it('the committed file matches what the generator produces right now', () => {
    const run = generate();
    expect(run.status, `the generator failed:\n${run.err}`).toBe(0);

    const committedPath = join(guardRoot(), DOC);
    expect(
      existsSync(committedPath),
      `${DOC} is missing from ${guardRoot()}. Run \`pnpm generate:third-party\`.`,
    ).toBe(true);

    expect(
      readFileSync(committedPath, 'utf8'),
      `${DOC} is stale. It is generated from installed package metadata, the bundled ` +
        `grammar files and grammar-provenance.json — never edited by hand. Run ` +
        `\`pnpm generate:third-party\` and commit the result.`,
    ).toBe(run.out);
  });

  it('names every grammar that actually ships', () => {
    const doc = readFileSync(join(guardRoot(), DOC), 'utf8');
    const shipped = [...new Set(Object.values(WASM_BY_LANGUAGE))].toSorted();
    const unmentioned = shipped.filter((file) => !doc.includes(file));
    expect(
      unmentioned,
      'these grammars are bundled but are not named in the notices, so they would be ' +
        'redistributed without attribution',
    ).toEqual([]);
    expect(shipped.length).toBeGreaterThanOrEqual(6);
  });

  it("grammar-provenance.json's key set equals the registry's wasm set — the totality tie", () => {
    // The generator already refuses a *bundled* grammar without provenance, but the
    // bundle is produced from the registry by a build step — so between "profile
    // added" and "pnpm build" nothing else compares the two directly. This pins the
    // partition at the source: every wasm the LanguageProfile registry names has a
    // provenance entry, and every provenance entry names a wasm some profile claims.
    // Read the staled copy when the mutation runner provides one, else the real file
    // — same pattern as the bench guard's artifacts.
    const staled = join(guardRoot(), 'grammar-provenance.json');
    const provenance = JSON.parse(
      readFileSync(
        existsSync(staled) ? staled : join(packageRoot(), 'grammar-provenance.json'),
        'utf8',
      ),
    ) as { grammars: Record<string, unknown> };
    const attributed = Object.keys(provenance.grammars).toSorted();
    const claimed = [...new Set(Object.values(WASM_BY_LANGUAGE))].toSorted();
    expect(
      attributed,
      'grammar-provenance.json and the registry disagree about which grammars exist — ' +
        'a profile shipped without attribution facts, or provenance outlived its grammar',
    ).toEqual(claimed);
  });

  it('names every runtime dependency, with a licence', () => {
    const doc = readFileSync(join(guardRoot(), DOC), 'utf8');
    const manifest = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const declared = Object.keys(manifest.dependencies ?? {});
    expect(
      declared.length,
      'no runtime dependencies found — is the manifest right?',
    ).toBeGreaterThan(0);
    for (const name of declared) expect(doc).toContain(name);
  });

  it('is listed in `files`, so it actually reaches the tarball', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as {
      files?: string[];
      bin?: Record<string, string>;
    };
    expect(
      manifest.files,
      'a notices file that is not packed is a notices file nobody receives',
    ).toContain(DOC);
    expect(manifest.files, 'the grammars must ship, or "works offline" is not true').toContain(
      'grammars',
    );
  });

  it('refuses to generate when a bundled grammar has no attribution', () => {
    // The partition, watched from the other side: the generator is pointed at a copy of
    // the package whose provenance map is missing an entry, and must throw rather than
    // quietly emit notices with a hole in them.
    const scratch = join(repoRoot(), '.mutants/third-party-partition');
    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const src = ${JSON.stringify(packageRoot())};
        const dst = ${JSON.stringify(scratch)};
        rmSync(dst, { recursive: true, force: true });
        mkdirSync(dst, { recursive: true });
        cpSync(join(src, 'grammars'), join(dst, 'grammars'), { recursive: true });
        cpSync(join(src, 'package.json'), join(dst, 'package.json'));
        const provenance = JSON.parse(readFileSync(join(src, 'grammar-provenance.json'), 'utf8'));
        const keys = Object.keys(provenance.grammars);
        delete provenance.grammars[keys[0]];
        writeFileSync(join(dst, 'grammar-provenance.json'), JSON.stringify(provenance));
        const { renderThirdParty } = await import(${JSON.stringify(GENERATOR)});
        try {
          renderThirdParty(dst);
          console.log('NO THROW');
        } catch (error) {
          console.log('THREW: ' + error.message);
        } finally {
          rmSync(dst, { recursive: true, force: true });
        }
        `,
      ],
      { encoding: 'utf8', cwd: repoRoot() },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('THREW:');
    expect(run.stdout).toContain('would ship unattributed');
  });
});
