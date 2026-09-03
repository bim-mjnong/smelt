import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ambientNamespaceViolations,
  deadSourcemapViolations,
  packPackage,
  type PackedPackage,
} from '@smelt/guard-kit';

import type { GuardMutation } from './_mutations.ts';
import { guardRoot, packageRoot, readSource } from './_source.ts';

/**
 * PACKAGING GUARD — this package's half of the tarball audit.
 *
 * `packages/core/test/guards/packaging.test.ts` states the reasoning in full: the
 * defects it was written for were properties of the bytes npm packs rather than of any
 * file under `src`, so the checks run over an extracted tarball. The MCP server ships
 * from the same build arrangement, so it can ship the same dead maps and the same
 * declarations that only compile in someone else's configuration.
 *
 * The third defect — a `smelt_retrieve` schema that strict structured outputs will not
 * register — is guarded here as a **re-fork** check rather than a re-assertion, and
 * that is the point. This server once wrote its own copy of the retrieve schema. One
 * contract, two documents: a library caller reading `RetrieveTool.inputSchema` and a
 * model reading `tools/list` could be told different things about the same call, and
 * nothing would report the day they diverged — which is exactly how the two packages
 * came to hold two budget laws (`test/guards/ops-seam.test.ts`). The schema is the
 * core's now, and this guard watches it stay the core's.
 *
 * The other three tools are deliberately not held to strict mode. `smelt_file` and
 * `repo_map` have genuinely optional arguments (`path`/`text`, `focus`, `strategy`),
 * and strict mode has no notion of optional: making them registrable would mean
 * requiring every key and spelling absence as `null`, which changes the calls a model
 * is allowed to make. `smelt_retrieve` has one argument and it was already required,
 * so stating the rule there changes nothing about what it accepts.
 */

let packed: PackedPackage;

beforeAll(() => {
  packed = packPackage(packageRoot());
}, 180_000);

afterAll(() => {
  packed?.cleanup();
});

describe('the packed tarball is what a consumer can actually build against', () => {
  it('packs the declarations and maps this guard is about — nothing here is vacuous', () => {
    expect(packed.files, 'the tarball has no dist/index.d.ts — was `pnpm build` run?').toContain(
      'dist/index.d.ts',
    );
    expect(packed.files.filter((file) => file.endsWith('.d.ts')).length).toBeGreaterThan(2);
    expect(packed.files.filter((file) => file.endsWith('.js.map')).length).toBeGreaterThan(2);
    expect(packed.files.filter((file) => file.endsWith('.d.ts.map')).length).toBeGreaterThan(2);
  });

  it('ships no declaration that names an ambient global namespace', () => {
    expect(ambientNamespaceViolations(packed).join('\n')).toBe('');
  });

  it('ships no sourcemap that resolves to a file it did not pack', () => {
    expect(deadSourcemapViolations(packed).join('\n')).toBe('');
  });

  it('tsconfig.json inlines sources into the emitted JavaScript maps', () => {
    // The declaration maps are filled by `scripts/inline-declaration-map-sources.mjs`,
    // which touches only `*.d.ts.map`; TypeScript's own `inlineSources` is what covers
    // `*.js.map`, and the script must not quietly paper over its loss.
    const path = join(guardRoot(), 'tsconfig.json');
    const config = JSON.parse(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n'),
    ) as { compilerOptions?: Record<string, unknown> };
    expect(
      config.compilerOptions?.['inlineSources'],
      `${path}: without inlineSources the emitted .js.map files name ../src/*.ts, a ` +
        `path "files" never packs — a dead map on every consumer's machine.`,
    ).toBe(true);
  });
});

describe("the served smelt_retrieve schema is the core's, not a copy of it", () => {
  const source = readSource('server.ts');

  it('serves RetrieveTool.inputSchema rather than writing its own', () => {
    expect(
      source,
      'server.ts no longer serves `retrieveTool.inputSchema`. The retrieve schema ' +
        'belongs to @smeltjs/core, beside the `invoke` that reads it and the ' +
        'strict-mode rules its own guard pins; a copy here is a second document for ' +
        'one contract, and the day they disagree nothing reports it.',
    ).toContain('retrieveTool.inputSchema');
  });

  it('writes no properties block of its own for that tool', () => {
    // A re-fork does not announce itself by deleting the reuse — it announces itself
    // by a hand-written schema appearing beside the tool name. This is that check.
    const retrieveEntry = source.slice(
      source.indexOf('name: RETRIEVE_TOOL_NAME,'),
      source.indexOf('name: REPO_MAP_TOOL_NAME,'),
    );
    expect(retrieveEntry, 'the retrieve tool entry was not found in server.ts').not.toBe('');
    expect(
      retrieveEntry.includes('properties: {'),
      'the retrieve tool entry writes its own `properties` block — that is the copy ' +
        'this guard exists to refuse. Serve the core schema instead.',
    ).toBe(false);
  });
});

export const MUTATIONS: GuardMutation[] = [
  {
    id: 'mcp-retrieve-schema-reforked',
    file: 'server.ts',
    find:
      '      inputSchema: {\n' +
      '        ...retrieveTool.inputSchema,\n' +
      '        required: [...retrieveTool.inputSchema.required],\n' +
      '      },',
    replace:
      '      inputSchema: {\n' +
      "        type: 'object',\n" +
      "        properties: { hash: { type: 'string' } },\n" +
      "        required: ['hash'],\n" +
      '      },',
    why: 'the retrieve schema re-forked into this server — one contract described in two places, and this copy has quietly lost additionalProperties, so a strict-structured-outputs client cannot register the one tool every marker points at',
  },
  {
    kind: 'artifact',
    id: 'mcp-sourcemaps-stop-inlining-sources',
    file: 'tsconfig.json',
    find: '"inlineSources": true,',
    replace: '"inlineSources": false,',
    why: 'the MCP package emitting .js.map files that name ../src/*.ts, a path its tarball never carries — dead maps for every consumer',
  },
];
