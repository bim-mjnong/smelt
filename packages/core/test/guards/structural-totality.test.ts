import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertKeyedById } from '@smelt/guard-kit';

import { LANGUAGE_PROFILES, structuralLanguages } from '@guard/lang/registry';

import { FIXTURE_BY_LANGUAGE } from '../structural-fixtures.ts';

import type { GuardMutation } from './_mutations.ts';
import { packageRoot } from './_source.ts';

/**
 * STRUCTURAL TOTALITY GUARD — a language cannot be claimed without tests.
 *
 * Bundled grammars made adding a language cheap, and the LanguageProfile registry made it
 * cheaper still: one profile file in `src/lang/` with a `structure` section, and the
 * extension map, grammar map and claimed-language list all follow. That is exactly
 * when the tests stop
 * keeping up — the planner compiles, the demo works, and the new language ships with
 * no fixture, no snapshot and no proof that a doc comment survives in its idiom. Six
 * months later a marker mislabels what it collapsed in that language and nothing is
 * red anywhere.
 *
 * So this guard closes the loop the type system cannot: for **every** language id the
 * structural planner claims, there must be
 *
 *   1. one profile under that id — the registry key and the profile's own `id` agree,
 *      so `profileFor(id)` (by key) and `structuralLanguages()` (from the field) name
 *      the same profile; `SUPPORTED_LANGUAGES` and `WASM_BY_LANGUAGE` are derived from
 *      the same registry, so their agreement is not a check but an identity,
 *   2. a fixture in `FIXTURE_BY_LANGUAGE` — with a focus, a signature line, and a
 *      **doc-comment case**: a doc comment in the language's own idiom that appears
 *      in the fixture and is asserted to survive by the structural guard, which
 *      iterates the same registry,
 *   3. a committed snapshot under the fixture's name, from `structural.test.ts` —
 *      which also derives its fixture list (and its determinism assertion) from the
 *      same registry, so an entry here *is* a snapshot test and a determinism test.
 *
 * The registry lives in test-land on purpose: the mutation runner redirects only the
 * library (`@guard`), so a mutant that claims a new language is measured against the
 * real, committed tests — and goes red here. `pnpm mutate` proves it.
 */

const SNAPSHOT_PATH = join(packageRoot(), 'test/__snapshots__/structural.test.ts.snap');

describe('structural totality — every claimed language has a fixture, a snapshot, and a doc-comment case', () => {
  // Parametrised over the LanguageProfile registry — the single home of per-language
  // facts — so a language claimed by adding a `structure` section to a profile is
  // measured against the committed tests, with no second list to fall behind.
  const claimed = structuralLanguages();

  it('claims at least the fifteen shipped languages, or the guard is vacuous', () => {
    expect(claimed.length).toBeGreaterThanOrEqual(15);
  });

  it('keys every profile by its own id — the by-key and from-field readers agree', () => {
    assertKeyedById(LANGUAGE_PROFILES, 'id');
  });

  it('every claimed language has a fixture with a focus, a signature and a doc-comment case', () => {
    const registered = Object.keys(FIXTURE_BY_LANGUAGE);
    for (const language of claimed) {
      expect(
        registered,
        `${language}: claimed by the structural planner but has no entry in ` +
          `FIXTURE_BY_LANGUAGE — add a fixture before claiming the language`,
      ).toContain(language);
      const fixture = FIXTURE_BY_LANGUAGE[language as keyof typeof FIXTURE_BY_LANGUAGE];
      expect(fixture.text.length, `${language}: empty fixture text`).toBeGreaterThan(0);
      expect(fixture.focus.length, `${language}: fixture has no focus`).toBeGreaterThan(0);
      expect(
        fixture.text.includes(fixture.signature),
        `${language}: the fixture does not contain its own signature line`,
      ).toBe(true);
      // The doc-comment case: the doc must be real text of the fixture, adjacent to
      // the material the focus keeps — the structural guard asserts it survives.
      expect(fixture.doc.length, `${language}: fixture has no doc-comment case`).toBeGreaterThan(0);
      expect(
        fixture.text.includes(fixture.doc),
        `${language}: the fixture does not contain its own doc comment`,
      ).toBe(true);
    }
    // Names are the snapshot keys, so two languages must not share one.
    const names = registered.map(
      (language) => FIXTURE_BY_LANGUAGE[language as keyof typeof FIXTURE_BY_LANGUAGE].name,
    );
    expect(new Set(names).size, 'two fixtures share a snapshot name').toBe(names.length);
  });

  it('every claimed language has a committed snapshot under its fixture name', () => {
    expect(
      existsSync(SNAPSHOT_PATH),
      `no snapshot file at ${SNAPSHOT_PATH} — run the structural tests once`,
    ).toBe(true);
    const snapshots = readFileSync(SNAPSHOT_PATH, 'utf8');
    for (const language of claimed) {
      const fixture = FIXTURE_BY_LANGUAGE[language as keyof typeof FIXTURE_BY_LANGUAGE];
      expect(
        snapshots.includes(`plans ${fixture.name} (snapshot)`),
        `${language}: no committed snapshot named "plans ${fixture.name} (snapshot)" — ` +
          `the language is claimed but its plan output is pinned nowhere`,
      ).toBe(true);
    }
  });

  it('the registry claims nothing the planner does not — the mapping is a partition', () => {
    for (const language of Object.keys(FIXTURE_BY_LANGUAGE)) {
      expect(
        claimed,
        `${language}: has a fixture but the structural planner does not claim it — ` +
          `dead test data, or a language dropped without its tests`,
      ).toContain(language);
    }
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'structural-language-claimed-without-tests',
    file: 'lang/registry.ts',
    find: '  swift,\n  bash,\n};',
    replace: "  swift,\n  bash,\n  lua: { ...bash, id: 'lua', extensions: ['lua'] },\n};",
    why: 'a language claimed by a registry profile with no fixture, no snapshot and no doc-comment case — exactly the untested-language ship the totality guard exists to refuse',
  },
];
