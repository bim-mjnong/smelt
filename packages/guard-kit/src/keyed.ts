import { expect } from 'vitest';

/**
 * The invariant every registry in `src/` carries and none of them can type-check:
 * the key **is** the id, and the entry says its id again.
 *
 * `LANGUAGE_PROFILES`, `HARNESS_PROFILES` and `SUBCOMMANDS` are each a
 * `Record<Id, Profile>` — totality is a compile error — whose profile also carries its
 * id as a field, because a consumer holding a profile rather than a key reads it from
 * there. Two spellings of one fact, and the two seams read different ones: `profileFor`
 * and `subcommandFor` look up **by key**, `harnessById` finds **by field**,
 * `structuralLanguages()` and `HARNESS_IDS` are mapped **from the field**. A key that
 * disagrees with its entry's id makes those name different profiles for one id, and
 * nothing goes red: the record is still total, every derived list still renders.
 *
 * This is one assertion, not a shared Registry module — the registries themselves stay
 * plain objects (ruling in ISSUES.md: a module would fail the deletion test).
 */
export function assertKeyedById<T>(registry: Readonly<Record<string, T>>, idField: keyof T): void {
  const entries = Object.entries(registry);
  expect(entries.length, 'an empty registry proves nothing').toBeGreaterThan(0);
  for (const [key, entry] of entries) {
    expect(
      entry[idField],
      `registry key "${key}" holds an entry whose \`${String(idField)}\` is ` +
        `"${String(entry[idField])}" — a by-key lookup and a by-field lookup of one id ` +
        `now name different entries`,
    ).toBe(key);
  }
}
