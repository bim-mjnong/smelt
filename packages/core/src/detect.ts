import type { DetectedLanguage, LanguageId } from './types.ts';

/**
 * Extension → language. Deliberately not a content sniffer: guessing from bytes gets
 * things wrong silently, and `'unknown'` costs nothing here — it selects the lexical
 * planner, which works on anything.
 */
const BY_EXTENSION: Readonly<Record<string, LanguageId>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  rs: 'rust',
  py: 'python',
  pyi: 'python',
  go: 'go',
};

/** Every language smelt has a grammar mapping for. Used by tests to stay total. */
export const SUPPORTED_LANGUAGES: readonly LanguageId[] = [
  'typescript',
  'tsx',
  'javascript',
  'rust',
  'python',
  'go',
];

/**
 * Detect the language of a path. Returns `'unknown'` for anything unmapped — which is
 * a normal outcome, not an error.
 */
export function detectLanguage(path: string | undefined): DetectedLanguage {
  if (path === undefined) return 'unknown';
  const base = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'unknown';
  const ext = base.slice(dot + 1).toLowerCase();
  return BY_EXTENSION[ext] ?? 'unknown';
}
