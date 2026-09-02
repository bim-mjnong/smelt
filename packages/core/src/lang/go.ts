import type { LanguageProfile } from './profile.ts';

export const go: LanguageProfile = {
  id: 'go',
  extensions: ['go'],
  wasm: 'tree-sitter-go.wasm',
  markerLeader: '// ',
  structure: {
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    // `//go:build` (and the legacy `// +build`) constrain the whole file's builds.
    pinnedCommentPattern: /^\/\/(go:build|\s*\+build)\s/,
    wrapperTypes: {},
    kindLabels: {
      function_declaration: 'function',
      method_declaration: 'method',
      type_declaration: 'type declaration',
      const_declaration: 'constant',
      var_declaration: 'variable',
      import_declaration: 'import declaration',
      package_clause: 'package clause',
    },
  },
  repomap: {
    defKinds: {
      function_declaration: 'function',
      method_declaration: 'method',
      type_spec: 'type',
    },
    refTypes: ['identifier', 'type_identifier'],
  },
};
