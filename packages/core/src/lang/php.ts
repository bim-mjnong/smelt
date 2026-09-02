import type { LanguageProfile } from './profile.ts';

export const php: LanguageProfile = {
  id: 'php',
  extensions: ['php'],
  wasm: 'tree-sitter-php.wasm',
  markerLeader: '// ',
  structure: {
    // `//`, `#` and `/** … */` PHPDoc are all comment nodes.
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    // `<?php` is what makes the rest of the file php at all.
    pinnedTypes: new Set(['php_tag']),
    wrapperTypes: {},
    kindLabels: {
      function_definition: 'function',
      class_declaration: 'class',
      interface_declaration: 'interface',
      trait_declaration: 'trait',
      enum_declaration: 'enum',
      const_declaration: 'constant',
      namespace_definition: 'namespace',
      namespace_use_declaration: 'use declaration',
      expression_statement: 'statement',
      php_tag: 'php tag',
      // Raw markup between `?>` and `<?php` — calling it a declaration would be the
      // marker lying about the tree.
      text: 'html section',
      text_interpolation: 'html section',
    },
  },
  // No def kinds: php names its definitions with `name` nodes, not identifiers, and
  // an omitted kind means fewer symbols on the map, never wrong ones.
  repomap: {
    defKinds: {},
    refTypes: ['name', 'variable_name'],
  },
};
