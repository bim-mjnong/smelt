import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve, sep } from 'node:path';

import { stripStringsAndComments } from './source.ts';

/**
 * PACKAGING — the guards' machine for auditing the *tarball*, not the repository.
 *
 * Three of smelt's worst consumer-facing bugs were all invisible to a repo-level
 * check, because each was a property of the bytes npm packs rather than of any file
 * under `src`:
 *
 *  - a shipped `.d.ts` naming an ambient namespace (`NodeJS.ReadableStream`), which
 *    only resolves inside a compilation that pulled `@types/node` into its *global*
 *    scope — so a consumer building with `skipLibCheck: false` failed on smelt's
 *    declarations, in smelt's own `node_modules`, with nothing they could fix;
 *  - every `.js.map` and `.d.ts.map` pointing at `../src/*.ts`, a directory `files`
 *    deliberately excludes — go-to-definition and stack traces landing on a path that
 *    was never published;
 *  - a tool schema that a strict-structured-outputs consumer cannot register.
 *
 * So the checks below run over an extracted tarball. `packPackage` runs the real
 * `npm pack` (with `--ignore-scripts`: the guard audits the `dist` the build just
 * produced, and re-running `prepack` inside a test would rebuild the world), and each
 * rule returns *violations as sentences* rather than throwing, so a guard can assert
 * one empty array and print everything that is wrong at once.
 */

/** An extracted tarball: where its `package/` directory is, and what is inside it. */
export interface PackedPackage {
  /** The extracted `package/` directory — the root a consumer's `node_modules` sees. */
  readonly root: string;
  /** Every packed file, as a package-relative POSIX path (`dist/cli/init.d.ts`). */
  readonly files: readonly string[];
  /** Remove the scratch directory. Call from `afterAll`. */
  readonly cleanup: () => void;
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (status ${String(result.status)}):\n` +
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

function walk(dir: string, root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, root));
    else found.push(relative(root, full).split(sep).join(posix.sep));
  }
  return found;
}

/**
 * Pack the package and extract it. The tarball is the artefact under audit: what npm
 * would publish, `files` filter and all.
 *
 * `--ignore-scripts` is deliberate. `prepack` rebuilds and regenerates, which a guard
 * must not do: the point is to audit the `dist` that `pnpm verify` just built, not a
 * fresh one this test made for itself.
 */
export function packPackage(packageDir: string): PackedPackage {
  const scratch = mkdtempSync(join(tmpdir(), 'smelt-pack-'));
  try {
    const printed = run(
      'npm',
      ['pack', '--ignore-scripts', '--pack-destination', scratch],
      packageDir,
    );
    const tarball = printed
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) => line.endsWith('.tgz'));
    if (tarball === undefined) throw new Error(`npm pack printed no tarball name:\n${printed}`);
    run('tar', ['-xzf', join(scratch, tarball)], scratch);
    const root = join(scratch, 'package');
    return {
      root,
      files: walk(root, root),
      cleanup: () => void rmSync(scratch, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The ambient namespaces a *types package* contributes to global scope, as opposed to
 * the ones `lib` gives every compilation. A declaration naming one of these compiles
 * only where that types package was globally included — which is the consumer's
 * configuration, not smelt's, and not something smelt may assume.
 *
 * A list, because a guard can only check names it knows; it is the shipped surface's
 * backstop, and the source-level rule beside it ("no smelt module names one at all")
 * is what a mutation can be watched breaking.
 */
export const AMBIENT_GLOBAL_NAMESPACES: readonly string[] = ['NodeJS', 'Deno', 'Bun', 'Chai'];

/** `/// <reference types="node" />` and friends, which *do* pull the namespace in. */
function referencedTypePackages(source: string): readonly string[] {
  return [...source.matchAll(/\/\/\/\s*<reference\s+types=["']([^"']+)["']\s*\/>/g)].map(
    (match) => match[1]!,
  );
}

/**
 * Every shipped `.d.ts` that names an ambient global namespace without a
 * `/// <reference types="…" />` that would supply it.
 *
 * Comments and strings are stripped first: a declaration is allowed to *discuss*
 * `NodeJS.ReadableStream` in the doc comment explaining why it does not use it.
 */
export function ambientNamespaceViolations(packed: PackedPackage): readonly string[] {
  const violations: string[] = [];
  for (const file of packed.files) {
    if (!file.endsWith('.d.ts')) continue;
    const source = readFileSync(join(packed.root, file), 'utf8');
    const referenced = referencedTypePackages(source);
    // A `types` reference is the escape hatch the TypeScript handbook names, so any
    // reference at all satisfies the rule — the point is that the file asks for what
    // it needs instead of hoping the consumer already had it.
    if (referenced.length > 0) continue;
    const code = stripStringsAndComments(source);
    for (const namespace of AMBIENT_GLOBAL_NAMESPACES) {
      if (new RegExp(`\\b${namespace}\\s*\\.`).test(code)) {
        violations.push(
          `${file} names the ambient namespace \`${namespace}\` with no ` +
            `\`/// <reference types="…" />\` to supply it — it typechecks only where the ` +
            `consumer happened to pull those types into global scope. Describe the shape ` +
            `structurally instead.`,
        );
      }
    }
  }
  return violations;
}

interface SourceMap {
  readonly sources?: readonly string[];
  readonly sourcesContent?: readonly (string | null)[];
  readonly sourceRoot?: string;
}

/**
 * Every shipped sourcemap that resolves to nothing on a consumer's machine.
 *
 * A map is honest one of two ways: it carries its sources inline (`sourcesContent`),
 * or every path in `sources` is a file that is actually in the tarball. Anything else
 * is a map that only worked in the repository it was built in.
 */
export function deadSourcemapViolations(packed: PackedPackage): readonly string[] {
  const inTarball = new Set(packed.files);
  const violations: string[] = [];
  for (const file of packed.files) {
    if (!file.endsWith('.map')) continue;
    const map = JSON.parse(readFileSync(join(packed.root, file), 'utf8')) as SourceMap;
    const sources = map.sources ?? [];
    if (sources.length === 0) {
      violations.push(`${file} names no sources at all`);
      continue;
    }
    const content = map.sourcesContent;
    if (
      Array.isArray(content) &&
      content.length === sources.length &&
      content.every((entry) => typeof entry === 'string')
    ) {
      continue;
    }
    for (const source of sources) {
      // Resolved the way a debugger resolves it: relative to the map's own location.
      const absolute = resolve(join(packed.root, file), '..', map.sourceRoot ?? '', source);
      const packedPath = relative(packed.root, absolute).split(sep).join(posix.sep);
      if (!inTarball.has(packedPath)) {
        violations.push(
          `${file} points at "${source}", which resolves to ${packedPath} — not in the ` +
            `tarball. Inline the sources (sourcesContent) or ship them.`,
        );
      }
    }
  }
  return violations;
}

/** The subset of JSON Schema these rules read. */
export interface ToolSchema {
  readonly type?: unknown;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly unknown[];
  readonly additionalProperties?: unknown;
}

/**
 * The rules OpenAI's structured-outputs **strict mode** enforces before it will accept
 * a function schema at all: every object states `additionalProperties: false`, and
 * `required` names every key in `properties`.
 *
 * Nothing here loosens or widens a tool: a schema satisfying these describes exactly
 * the same accepted values as one that already ignored unknown keys and treated every
 * listed key as mandatory. It is the *same shape, stated precisely enough to register*.
 */
export function strictModeViolations(schema: ToolSchema, label: string): readonly string[] {
  const violations: string[] = [];
  if (schema.type !== 'object') {
    violations.push(`${label}: type is ${JSON.stringify(schema.type)}, not "object"`);
  }
  if (schema.additionalProperties !== false) {
    violations.push(
      `${label}: strict mode requires \`additionalProperties: false\` — without it the ` +
        `schema cannot be registered as a strict function at all, and a whole class of ` +
        `consumer simply cannot expose the tool.`,
    );
  }
  const properties = Object.keys(schema.properties ?? {});
  const required = new Set((schema.required ?? []).map((entry) => String(entry)));
  for (const property of properties) {
    if (!required.has(property)) {
      violations.push(
        `${label}: "${property}" is a property but is not in \`required\` — strict mode ` +
          `requires every property to be required.`,
      );
    }
  }
  for (const entry of required) {
    if (!properties.includes(entry)) {
      violations.push(`${label}: \`required\` names "${entry}", which is not a property`);
    }
  }
  return violations;
}
