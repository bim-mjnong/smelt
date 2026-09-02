import type { LanguageId } from '../types.ts';

import type { LanguageProfile } from './profile.ts';
import { bash } from './bash.ts';
import { c } from './c.ts';
import { c_sharp } from './c_sharp.ts';
import { cpp } from './cpp.ts';
import { go } from './go.ts';
import { java } from './java.ts';
import { javascript } from './javascript.ts';
import { kotlin } from './kotlin.ts';
import { php } from './php.ts';
import { python } from './python.ts';
import { ruby } from './ruby.ts';
import { rust } from './rust.ts';
import { swift } from './swift.ts';
import { tsx } from './tsx.ts';
import { typescript } from './typescript.ts';

/**
 * The registry — every language smelt knows, one {@link LanguageProfile} each.
 *
 * `Record<LanguageId, LanguageProfile>` on purpose: adding a `LanguageId` in
 * `types.ts` without writing its profile is a compile error, so the id list and the
 * facts cannot drift. Every derived view — `SUPPORTED_LANGUAGES`,
 * `WASM_BY_LANGUAGE`, `STRUCTURAL_LANGUAGES`, the extension map, the marker leaders,
 * the repo-map tag tables — is computed from this object, never written twice.
 *
 * Key order is meaningful: it is the order every rendered language list uses (the
 * `--language`/`--strategy` help, the init wizard, error messages), so keep it stable
 * and append new languages at the end.
 */
export const LANGUAGE_PROFILES: Readonly<Record<LanguageId, LanguageProfile>> = {
  typescript,
  tsx,
  javascript,
  rust,
  python,
  go,
  java,
  c,
  cpp,
  c_sharp,
  ruby,
  php,
  kotlin,
  swift,
  bash,
};

/** The profile for a language id. Total by construction — see the registry type. */
export function profileFor(id: LanguageId): LanguageProfile {
  return LANGUAGE_PROFILES[id];
}

/** Extension → profile, derived once. A duplicate claim would be a registry bug. */
const BY_EXTENSION: ReadonlyMap<string, LanguageProfile> = (() => {
  const index = new Map<string, LanguageProfile>();
  for (const profile of Object.values(LANGUAGE_PROFILES)) {
    for (const extension of profile.extensions) {
      const holder = index.get(extension);
      if (holder !== undefined) {
        throw new Error(
          `smelt: extension ".${extension}" is claimed by both "${holder.id}" and ` +
            `"${profile.id}" — a path would detect as whichever loaded last.`,
        );
      }
      index.set(extension, profile);
    }
  }
  return index;
})();

/**
 * The profile a path's extension selects, or `undefined` for anything unmapped.
 * Deliberately not a content sniffer: guessing from bytes gets things wrong silently,
 * and `undefined` costs nothing here — `detectLanguage` turns it into `'unknown'`,
 * which selects the lexical planner, and that works on anything.
 */
export function profileForPath(path: string | undefined): LanguageProfile | undefined {
  if (path === undefined) return undefined;
  const base = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return BY_EXTENSION.get(base.slice(dot + 1).toLowerCase());
}

/**
 * The languages the structural planner claims: exactly the profiles that carry a
 * `structure` section. In registry order, so every rendered list agrees.
 */
export function structuralLanguages(): readonly LanguageId[] {
  return Object.values(LANGUAGE_PROFILES)
    .filter((profile) => profile.structure !== undefined)
    .map((profile) => profile.id);
}
