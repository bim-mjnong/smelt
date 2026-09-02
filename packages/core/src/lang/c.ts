import type { LanguageProfile } from './profile.ts';

export const c: LanguageProfile = {
  id: 'c',
  extensions: ['c', 'h'],
  wasm: 'tree-sitter-c.wasm',
  markerLeader: '// ',
  structure: {
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    // Every `#pragma` is a preproc_call; only `#pragma once` governs what including
    // the file *means*, so only it is pinned — the `//go:build` law again.
    pinnedPatternsByType: { preproc_call: /^#\s*pragma\s+once\b/ },
    wrapperTypes: {},
    kindLabels: {
      function_definition: 'function',
      declaration: 'declaration',
      struct_specifier: 'struct',
      union_specifier: 'union',
      enum_specifier: 'enum',
      type_definition: 'type definition',
      preproc_include: 'include directive',
      preproc_def: 'macro definition',
      preproc_function_def: 'macro definition',
      // `#pragma`, `#if`/`#ifdef` regions — read off the tree, never "declaration".
      preproc_call: 'preprocessor directive',
      preproc_if: 'preprocessor conditional',
      preproc_ifdef: 'preprocessor conditional',
      preproc_else: 'preprocessor conditional',
    },
  },
  repomap: {
    defKinds: {
      struct_specifier: 'struct',
      union_specifier: 'union',
      enum_specifier: 'enum',
    },
    refTypes: ['identifier', 'type_identifier'],
  },
};
