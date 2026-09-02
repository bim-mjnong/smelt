import { LANGUAGE_PROFILES, profileForPath } from './lang/registry.ts';
import type { DetectedLanguage, LanguageId } from './types.ts';

/**
 * Every language smelt has a grammar mapping for — the registry's ids, in registry
 * order. A derived view of `LANGUAGE_PROFILES`, kept as an export because tests and
 * the CLI's rendered lists read it.
 */
export const SUPPORTED_LANGUAGES: readonly LanguageId[] = Object.values(LANGUAGE_PROFILES).map(
  (profile) => profile.id,
);

/**
 * Detect the language of a path, from its extension. Returns `'unknown'` for anything
 * unmapped — which is a normal outcome, not an error: it selects the lexical planner,
 * which works on anything. The extension → profile mapping itself lives on each
 * language's `LanguageProfile` (`src/lang/`); this is the id-shaped view of
 * {@link profileForPath}.
 */
export function detectLanguage(path: string | undefined): DetectedLanguage {
  return profileForPath(path)?.id ?? 'unknown';
}
