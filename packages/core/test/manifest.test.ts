import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { packageRoot, repoRoot } from './guards/_source.ts';

/**
 * Publish-surface pins — the manifest facts a release quietly breaks.
 *
 * Each of these was (or nearly was) a release blocker found by auditing the packed
 * tarball rather than the repo:
 *
 *  - `exports` without a `default` condition makes `require('@smeltjs/core')` throw
 *    ERR_PACKAGE_PATH_NOT_EXPORTED on the very Node versions the engines field
 *    promises (the floor ^20.19 || >=22.12 *is* the unflagged require(esm) floor).
 *  - no top-level `main` breaks node10-resolution tooling (bundlers, editors, jest
 *    configs) that never reads `exports`.
 *  - a scoped package without `publishConfig.access: "public"` fails its first
 *    `npm publish` outright.
 *  - a LICENSE outside the package directory is a LICENSE npm does not pack: the
 *    tarball would redistribute Apache-2.0-licensed grammars with no licence text.
 *
 * `test/cli-bin.test.ts` proves the require(esm) claim against the built output; this
 * file pins the manifest shape so the property cannot drift between builds.
 */

interface Manifest {
  readonly main?: string;
  readonly exports?: Record<string, unknown>;
  readonly publishConfig?: { readonly access?: string };
  readonly engines?: { readonly node?: string };
}

const manifest = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as Manifest;

describe('the publish surface of package.json', () => {
  it('exports ".": types first, then import, then default — all pointing at dist', () => {
    const dot = manifest.exports?.['.'] as Record<string, string> | undefined;
    expect(dot, 'the manifest lost its "." export').toBeDefined();
    // Order matters to Node's resolver: `types` must come first (TypeScript reads
    // conditions in order), and `default` must exist so require(esm) resolves.
    expect(Object.keys(dot!)).toEqual(['types', 'import', 'default']);
    expect(dot!['types']).toBe('./dist/index.d.ts');
    expect(dot!['import']).toBe('./dist/index.js');
    expect(dot!['default']).toBe('./dist/index.js');
  });

  it('carries a node10 main field agreeing with the exports map', () => {
    expect(manifest.main).toBe('./dist/index.js');
  });

  it('declares public access, so the scoped first publish cannot fail on the default', () => {
    expect(manifest.publishConfig?.access).toBe('public');
  });

  it('keeps the engines floor at the unflagged require(esm) floor', () => {
    expect(manifest.engines?.node).toBe('^20.19.0 || >=22.12.0');
  });
});

describe('the packaged LICENSE', () => {
  it('exists inside the package directory and is byte-identical to the root LICENSE', () => {
    // npm auto-includes a LICENSE file only from the package directory itself; the
    // root copy stays the canonical one for the repository. CONTRIBUTING.md
    // § "Generated files" documents the copy; this test is the sync check.
    const root = readFileSync(join(repoRoot(), 'LICENSE'), 'utf8');
    const packaged = readFileSync(join(packageRoot(), 'LICENSE'), 'utf8');
    expect(root).toContain('Apache License');
    expect(
      packaged === root,
      'packages/core/LICENSE has drifted from the root LICENSE — re-copy it ' +
        '(cp LICENSE packages/core/LICENSE)',
    ).toBe(true);
  });
});
