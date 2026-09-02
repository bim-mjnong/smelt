import type { LanguageProfile, LanguageStructure } from './profile.ts';

/**
 * Human words for the tree-sitter node types the structural planner expects at the
 * top level of a TypeScript or TSX file. What the map does not name, the planner
 * still labels honestly — see {@link LanguageStructure.kindLabels}.
 */
export const TS_KIND_LABELS: Readonly<Record<string, string>> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_signature: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type alias',
  enum_declaration: 'enum',
  lexical_declaration: 'variable',
  variable_declaration: 'variable',
  import_statement: 'import statement',
  internal_module: 'namespace',
  module: 'namespace',
  ambient_declaration: 'ambient declaration',
  expression_statement: 'statement',
  hash_bang_line: 'shebang',
  comment: 'comment',
};

/** One grammar family, two ids: the tsx profile shares this structure verbatim. */
export const TS_STRUCTURE: LanguageStructure = {
  commentTypes: new Set(['comment']),
  attributeTypes: new Set(),
  // `#!/usr/bin/env -S npx tsx` parses as a hash_bang_line here too — same node, same
  // law as javascript's: collapsing it changes which interpreter runs the file.
  pinnedTypes: new Set(['hash_bang_line']),
  wrapperTypes: { export_statement: 'export' },
  kindLabels: TS_KIND_LABELS,
};

/**
 * Repo-map definition kinds for the typescript grammar family — shared by the
 * typescript, tsx and javascript profiles, exactly as the extraction treats them.
 */
export const TS_DEF_KINDS: Readonly<Record<string, string>> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_signature: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type alias',
  enum_declaration: 'enum',
  method_definition: 'method',
  variable_declarator: 'variable',
};

/** Repo-map reference node types for the typescript grammar family. */
export const TS_REF_TYPES: readonly string[] = ['identifier', 'type_identifier'];

export const typescript: LanguageProfile = {
  id: 'typescript',
  extensions: ['ts', 'mts', 'cts'],
  wasm: 'tree-sitter-typescript.wasm',
  markerLeader: '// ',
  structure: TS_STRUCTURE,
  repomap: { defKinds: TS_DEF_KINDS, refTypes: TS_REF_TYPES },
};
