import type { LanguageProfile } from './profile.ts';

export const cpp: LanguageProfile = {
  id: 'cpp',
  extensions: ['cc', 'cpp', 'hpp'],
  wasm: 'tree-sitter-cpp.wasm',
  markerLeader: '// ',
  structure: {
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    // Same preprocessor, same `#pragma once` pin as c.
    pinnedPatternsByType: { preproc_call: /^#\s*pragma\s+once\b/ },
    // `template <typename T> class Box {}` — the marker should say what the template
    // declares, not just that it is a template.
    wrapperTypes: { template_declaration: 'template' },
    kindLabels: {
      function_definition: 'function',
      declaration: 'declaration',
      struct_specifier: 'struct',
      class_specifier: 'class',
      union_specifier: 'union',
      enum_specifier: 'enum',
      type_definition: 'type definition',
      alias_declaration: 'type alias',
      namespace_definition: 'namespace',
      using_declaration: 'using declaration',
      linkage_specification: 'extern block',
      preproc_include: 'include directive',
      preproc_def: 'macro definition',
      preproc_function_def: 'macro definition',
      preproc_call: 'preprocessor directive',
      preproc_if: 'preprocessor conditional',
      preproc_ifdef: 'preprocessor conditional',
      preproc_else: 'preprocessor conditional',
    },
  },
  repomap: {
    defKinds: {
      class_specifier: 'class',
      struct_specifier: 'struct',
      union_specifier: 'union',
      enum_specifier: 'enum',
      namespace_definition: 'namespace',
    },
    refTypes: ['identifier', 'type_identifier'],
  },
};
