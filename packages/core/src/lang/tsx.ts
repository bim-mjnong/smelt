import type { LanguageProfile } from './profile.ts';
import { TS_DEF_KINDS, TS_REF_TYPES, TS_STRUCTURE } from './typescript.ts';

/** TSX is the typescript grammar family's second id — same structure, same facts. */
export const tsx: LanguageProfile = {
  id: 'tsx',
  extensions: ['tsx'],
  wasm: 'tree-sitter-tsx.wasm',
  markerLeader: '// ',
  structure: TS_STRUCTURE,
  repomap: { defKinds: TS_DEF_KINDS, refTypes: TS_REF_TYPES },
};
