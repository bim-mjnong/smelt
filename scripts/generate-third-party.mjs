#!/usr/bin/env node
/**
 * Generate `packages/core/THIRD-PARTY.md`.
 *
 * smelt bundles tree-sitter grammar `.wasm` blobs inside its npm tarball — that is what
 * makes "zero native compilation, works offline" true — and bundling is
 * **redistribution**, so attribution is required rather than polite. Downstream this is
 * not academic: KLØDD ships in two app stores and needs this text for its own licence
 * screen.
 *
 * The document is **generated, never hand-written**, because a hand-written notice file
 * is a promise that decays: a grammar gets added, the file does not, and nothing
 * anywhere fails. Every fact here is read from installed package metadata, from the
 * bundled files themselves, or from `grammar-provenance.json` — which holds only the
 * facts that have no machine-readable source on this machine (a `.wasm` blob carries no
 * licence, and the grammar packages are `tree-sitter-wasms`' own devDependencies, so
 * they are never installed here).
 *
 * The grammar ↔ provenance mapping is a **partition**: a bundled grammar with no
 * provenance entry, or an entry naming nothing bundled, throws. A new grammar cannot
 * ship unattributed.
 *
 * `packages/core/test/guards/third-party.test.ts` regenerates this and fails if the
 * committed copy differs, so staleness is loud. Run `pnpm generate:third-party` to fix.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_PACKAGE = join(repoRoot, 'packages/core');

/** The file this generator owns. Nothing else may write it. */
export const THIRD_PARTY_PATH = join(CORE_PACKAGE, 'THIRD-PARTY.md');

const BANNER =
  '<!-- GENERATED FILE — do not edit by hand.\n' +
  '     Produced by scripts/generate-third-party.mjs from installed package metadata,\n' +
  '     the bundled grammar files, and packages/core/grammar-provenance.json.\n' +
  '     Regenerate with `pnpm generate:third-party`; a stale copy fails\n' +
  '     packages/core/test/guards/third-party.test.ts. -->';

/**
 * Render the whole document. Pure with respect to the filesystem it is handed: reads,
 * never writes, so the freshness guard can compare it against the committed copy.
 */
export function renderThirdParty(corePackage = CORE_PACKAGE) {
  const manifest = readJson(join(corePackage, 'package.json'));
  const provenance = readJson(join(corePackage, 'grammar-provenance.json'));
  const require = createRequire(join(corePackage, 'package.json'));

  const grammarDir = join(corePackage, 'grammars');
  if (!existsSync(grammarDir)) {
    throw new Error(
      'generate-third-party: packages/core/grammars/ does not exist. Run `pnpm build` ' +
        'first — the notices describe the files that actually ship, not the ones that ' +
        'were meant to.',
    );
  }
  const bundled = readdirSync(grammarDir)
    .filter((file) => file.endsWith('.wasm'))
    .sort();
  if (bundled.length === 0) {
    throw new Error('generate-third-party: grammars/ holds no .wasm files.');
  }

  // The partition. Neither direction is allowed to be lopsided.
  const attributed = Object.keys(provenance.grammars).sort();
  const unattributed = bundled.filter((file) => !attributed.includes(file));
  const orphaned = attributed.filter((file) => !bundled.includes(file));
  if (unattributed.length > 0) {
    throw new Error(
      `generate-third-party: these bundled grammars have no entry in ` +
        `grammar-provenance.json, so they would ship unattributed: ` +
        `${unattributed.join(', ')}`,
    );
  }
  if (orphaned.length > 0) {
    throw new Error(
      `generate-third-party: grammar-provenance.json attributes files that are not ` +
        `bundled: ${orphaned.join(', ')}. Remove them, or fix WASM_BY_LANGUAGE.`,
    );
  }

  const runtimeDeps = Object.keys(manifest.dependencies ?? {}).sort();
  if (runtimeDeps.length === 0) {
    throw new Error('generate-third-party: no runtime dependencies found in the manifest.');
  }

  const packaging = installed(require, 'tree-sitter-wasms');
  const grammarRanges = packaging.manifest.devDependencies ?? {};

  const lines = [];
  lines.push('# Third-party notices');
  lines.push('');
  lines.push(BANNER);
  lines.push('');
  lines.push(
    `\`${manifest.name}\` redistributes the files listed below inside its npm tarball. ` +
      `Everything here is someone else's work, under someone else's licence.`,
  );
  lines.push('');
  lines.push(
    'Attribution is required rather than courteous, because the parsers are **shipped**, ' +
      'not merely depended on: that is what makes "no native compilation, works offline" ' +
      'true. If you redistribute smelt, this file travels with it.',
  );
  lines.push('');

  // --- runtime dependencies ------------------------------------------------
  lines.push('## Runtime dependencies');
  lines.push('');
  for (const name of runtimeDeps) {
    const dep = installed(require, name);
    lines.push(`### ${name} ${dep.manifest.version} — ${licenseOf(dep)}`);
    lines.push('');
    lines.push(`- Repository: ${repositoryOf(dep)}`);
    lines.push(`- Declared range: \`${manifest.dependencies[name]}\``);
    lines.push('');
    lines.push('```text');
    lines.push(dep.licenseText.trimEnd());
    lines.push('```');
    lines.push('');
  }

  // --- bundled grammars ----------------------------------------------------
  lines.push('## Bundled tree-sitter grammars');
  lines.push('');
  lines.push(
    `The \`.wasm\` parsers in \`grammars/\` were taken from ` +
      `**${packaging.manifest.name} ${packaging.manifest.version}** ` +
      `(${licenseOf(packaging)}), which prebuilds them. The packaging licence covers ` +
      `the packaging; each grammar carries its own, listed after the table.`,
  );
  lines.push('');
  lines.push('| file | from | version range | licence | bytes | sha256 |');
  lines.push('| ---- | ---- | ------------- | ------- | ----- | ------ |');
  for (const file of bundled) {
    const entry = provenance.grammars[file];
    const range = grammarRanges[entry.package];
    if (range === undefined) {
      throw new Error(
        `generate-third-party: ${packaging.manifest.name} does not declare ` +
          `"${entry.package}", so the version that produced ${file} cannot be stated. ` +
          `Either the upstream packaging changed or grammar-provenance.json is wrong.`,
      );
    }
    const bytes = readFileSync(join(grammarDir, file));
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    lines.push(
      `| \`${file}\` | ${entry.package} | \`${range}\` | ${entry.license} | ` +
        `${String(bytes.length)} | \`${digest}\` |`,
    );
  }
  lines.push('');
  lines.push(`### Copyright notices`);
  lines.push('');
  lines.push(
    `Licence identifiers and copyright lines below were verified on ` +
      `**${provenance.verified}** against the npm registry and each repository's ` +
      `\`LICENSE\` file, and are recorded in \`grammar-provenance.json\`. They are not ` +
      `derivable on this machine: a \`.wasm\` blob carries no metadata, and the grammar ` +
      `packages are ${packaging.manifest.name}'s own devDependencies, so they are never ` +
      `installed here.`,
  );
  lines.push('');
  for (const name of uniqueSorted(Object.values(provenance.grammars).map((g) => g.package))) {
    const entry = Object.values(provenance.grammars).find((g) => g.package === name);
    lines.push(`- **${name}** — ${entry.license} — ${entry.copyright} — ${entry.repository}`);
  }
  lines.push('');
  lines.push('### Packaging licence');
  lines.push('');
  lines.push('```text');
  lines.push(packaging.licenseText.trimEnd());
  lines.push('```');
  lines.push('');

  // --- the MIT body, once --------------------------------------------------
  const mit = runtimeDeps
    .map((name) => installed(require, name))
    .find((dep) => licenseOf(dep) === 'MIT');
  if (mit === undefined) {
    throw new Error(
      'generate-third-party: no installed MIT dependency to take the licence body from. ' +
        'The MIT text is quoted from a real installed LICENSE rather than typed out here, ' +
        'so that this generator never becomes a place licence text is authored.',
    );
  }
  lines.push('### The MIT licence');
  lines.push('');
  lines.push(
    `Every grammar above is MIT. The body is reproduced once, quoted from the installed ` +
      `\`${mit.manifest.name}\` \`LICENSE\` — each grammar's own copy differs only in the ` +
      `copyright line listed above.`,
  );
  lines.push('');
  lines.push('```text');
  lines.push(mit.licenseText.trimEnd());
  lines.push('```');

  return `${lines.join('\n')}\n`;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Locate an installed package's own directory, whatever its `exports` map allows. */
function installed(require, name) {
  let dir;
  try {
    dir = dirname(require.resolve(`${name}/package.json`));
  } catch {
    dir = nearestPackageDir(require.resolve(name), name);
  }
  const manifest = readJson(join(dir, 'package.json'));

  const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']
    .map((file) => join(dir, file))
    .find((path) => existsSync(path));
  if (licenseFile === undefined) {
    throw new Error(
      `generate-third-party: ${name} ships no LICENSE file, so its notice cannot be ` +
        `reproduced. Do not paraphrase it here — find the text upstream and record how.`,
    );
  }
  return { manifest, licenseText: readFileSync(licenseFile, 'utf8') };
}

function nearestPackageDir(entry, name) {
  let dir = dirname(entry);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`generate-third-party: cannot locate the installed root of ${name}.`);
}

function licenseOf(dep) {
  const license = dep.manifest.license;
  if (typeof license !== 'string' || license === '') {
    throw new Error(
      `generate-third-party: ${dep.manifest.name} declares no license field. Refusing ` +
        `to guess one.`,
    );
  }
  return license;
}

function repositoryOf(dep) {
  const repository = dep.manifest.repository;
  const url = typeof repository === 'string' ? repository : (repository?.url ?? '');
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/**
 * The emitted document is passed through prettier (the repo's own devDependency,
 * with the repo's own config) before it is written or printed, so the committed
 * file is a **fixed point of `prettier --write`**: a formatting pass over the tree
 * is a no-op on it and can never make the committed copy disagree with what this
 * generator produces. This matters because a `.prettierignore` entry cannot be
 * relied on to protect it — prettier resolves its default ignore files
 * (`.gitignore`, `.prettierignore`) against the process cwd only, with no upward
 * search, so any invocation started anywhere but the repo root (an editor's
 * format-on-save, a `prettier --write .` from `packages/core`) silently bypasses
 * the entry and reformats the file into a state the freshness guard rejects.
 * Canonical-by-construction beats hoping the ignore file is seen.
 */
async function formatted(markdown) {
  const { format, resolveConfig } = await import('prettier');
  const config = (await resolveConfig(THIRD_PARTY_PATH)) ?? {};
  return format(markdown, { ...config, filepath: THIRD_PARTY_PATH });
}

if (invokedDirectly) {
  // `--print` writes to stdout instead of the file. The freshness guard uses it, so the
  // guard checks the generator that actually ships rather than a copy of its logic.
  const document = await formatted(renderThirdParty());
  if (process.argv.includes('--print')) {
    process.stdout.write(document);
  } else {
    writeFileSync(THIRD_PARTY_PATH, document);
    process.stderr.write('generate-third-party: wrote packages/core/THIRD-PARTY.md\n');
  }
}
