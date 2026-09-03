import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertKeyedById } from '@smelt/guard-kit';

import { LANGUAGE_PROFILES, structuralLanguages } from '@guard/lang/registry';
import { WASM_BY_LANGUAGE } from '@guard/plan/grammar';

import { FIXTURE_BY_LANGUAGE } from '../structural-fixtures.ts';

import type { GuardMutation } from './_mutations.ts';
import { guardRoot, packageRoot, repoRoot } from './_source.ts';

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
 * THE DOCUMENTS NAME THE SAME LANGUAGES — the other half of the claim.
 *
 * The registry is the single home of per-language facts, and everything the *code*
 * renders is a view over it. The prose was not: README.md typed "**fifteen languages**"
 * and all fifteen ids, docs/ARCHITECTURE.md typed "Fifteen languages: TypeScript, …"
 * and CONTRIBUTING.md's release checklist typed "all fifteen `grammars/*.wasm`" — four
 * hand-written copies of a derivable fact, with only a `>= 15` vacuity floor above
 * them. A sixteenth language would have left every document saying fifteen beside a
 * fifteen-name list, silently: the exact failure this branch removed for the mutation
 * tally and the tier table, still live one document over.
 *
 * The ruling that keeps the README's tier table hand-written applies here too — a
 * generated language list would be a view agreeing with itself. So the lists stay
 * written by a human and are *pinned* to the registry: the ids as README spells them,
 * the display names as ARCHITECTURE spells them (normalised: `C++` → `cpp`, `C#` →
 * `c_sharp`), and every spelled-out number a sentence about languages or grammars
 * carries.
 */

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
] as const;

/**
 * A repository document. Normally read from the repository; from the mutation runner's
 * scratch root when it made one — which is exactly when `guardRoot()` stops being this
 * package's own root. The indirection matters: `packages/core/README.md` exists too, so
 * joining `guardRoot()` blindly would read the wrong README on every ordinary run.
 */
function document(relative: string): string {
  const root = guardRoot() === packageRoot() ? repoRoot() : guardRoot();
  const staled = join(root, relative);
  return readFileSync(existsSync(staled) ? staled : join(repoRoot(), relative), 'utf8');
}

/** `bash` from `` `bash` ``; the ids a markdown list spells in backticks, in order. */
const backticked = (list: string): readonly string[] =>
  [...list.matchAll(/`(?<id>[a-z_0-9]+)`/gu)].map((match) => match.groups!['id']!);

/** `C++` → `cpp`, `C#` → `c_sharp`, `TypeScript` → `typescript` — no hand-written map. */
const asId = (name: string): string =>
  name.trim().toLowerCase().replace('++', 'pp').replace('#', '_sharp');

describe('the documents name the languages the registry claims', () => {
  const claimed = structuralLanguages();
  const grammars = new Set(Object.values(WASM_BY_LANGUAGE)).size;

  it("README's structural-planner bullet lists the claimed ids, in order", () => {
    const bullet = /languages\*\*\s*\((?<list>[^)]*)\)/u.exec(document('README.md'));
    expect(
      bullet?.groups?.['list'],
      'README.md no longer lists the structural languages where this guard reads them ' +
        '(a `**… languages**` phrase followed by a parenthesised list of backticked ids) — ' +
        'the list is pinned to the registry, so it has to be findable',
    ).toBeDefined();
    expect(
      backticked(bullet!.groups!['list']!),
      'README.md names a different set of structural languages than the registry claims',
    ).toEqual([...claimed]);
  });

  it("ARCHITECTURE's language sentence names the claimed languages, in order", () => {
    const sentence = /(?<count>[A-Za-z]+)\s+languages:\s+(?<list>[^—]+)—/u.exec(
      document('docs/ARCHITECTURE.md'),
    );
    expect(
      sentence?.groups?.['list'],
      'docs/ARCHITECTURE.md no longer names the structural languages where this guard ' +
        'reads them (a "… languages: A, B and C —" sentence)',
    ).toBeDefined();
    const named = sentence!
      .groups!['list']!.split(/,\s*|\s+and\s+/u)
      .filter((name) => name.trim() !== '');
    expect(
      named.map(asId),
      'docs/ARCHITECTURE.md names a different set of structural languages than the ' +
        'registry claims — a language added to the registry, and a sentence nobody edited',
    ).toEqual([...claimed]);
  });

  it('no document spells a count of languages or grammars the registry disagrees with', () => {
    // Every spelled-out number in a clause about languages, grammars or their licences.
    // Digits are not scanned: these documents state counts in words, and the tally's own
    // guard (`guards-manifest.test.ts`) owns the digit case.
    const words = NUMBER_WORDS.join('|');
    const expected = (count: number): string => {
      expect(
        count,
        `the registry claims ${String(count)} of a thing the documents spell out in ` +
          `words, and NUMBER_WORDS stops at ${String(NUMBER_WORDS.length - 1)} — extend it`,
      ).toBeLessThan(NUMBER_WORDS.length);
      return NUMBER_WORDS[count]!;
    };
    const contexts = [
      // The noun the number counts, immediately after it — "fifteen languages",
      // "fifteen supported languages", "fifteen `grammars/*.wasm`", "all fifteen are
      // MIT". Deliberately tight: a window of any 40 characters caught "One" in a
      // sentence that happens to mention languages later.
      {
        about: 'languages',
        after: String.raw`(?:supported\s+|structural\s+)?languages?`,
        count: claimed.length,
      },
      { about: 'grammars', after: String.raw`\x60?grammars?|are\s+MIT`, count: grammars },
    ];
    for (const relative of ['README.md', 'docs/ARCHITECTURE.md', 'CONTRIBUTING.md']) {
      const text = document(relative);
      for (const context of contexts) {
        // `\s+` rather than a space: README wraps "**fifteen\n  languages**" across two
        // lines, and the drift is the same drift on either side of a line break.
        const pattern = new RegExp(`\\b(${words})\\b\\s+(?:${context.after})\\b`, 'giu');
        for (const match of text.matchAll(pattern)) {
          expect(
            match[1]!.toLowerCase(),
            `${relative} says "${match[1]!}" where the registry has ${String(context.count)} ` +
              `${context.about}. The list is hand-written on purpose — an outside witness — ` +
              `but it is pinned: update the sentence, or the document is the last place ` +
              `still saying the old number.`,
          ).toBe(expected(context.count));
        }
      }
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
  {
    kind: 'artifact',
    id: 'documents-name-a-language-set-of-their-own',
    file: 'docs/ARCHITECTURE.md',
    find: 'Kotlin, Swift and Bash',
    replace: 'Kotlin and Swift',
    why: 'a document listing one language fewer than the registry claims — the drift that was live in two documents at once, under a `>= 15` floor that a fourteen-name list and the word "fifteen" both satisfy',
  },
];
