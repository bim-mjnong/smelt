import type { LanguageProfile } from './profile.ts';

export const kotlin: LanguageProfile = {
  id: 'kotlin',
  extensions: ['kt', 'kts'],
  wasm: 'tree-sitter-kotlin.wasm',
  markerLeader: '// ',
  structure: {
    // `//` is line_comment; `/** … */` KDoc is multiline_comment.
    commentTypes: new Set(['line_comment', 'multiline_comment']),
    attributeTypes: new Set(),
    // `#!/usr/bin/env kotlin` parses as a shebang_line node; same law as the rest.
    pinnedTypes: new Set(['shebang_line']),
    // tree-sitter-kotlin extends import_list over a doc comment that directly
    // follows it — the KDoc of the first documented declaration after the imports.
    // Split it back out, or that declaration loses its doc to the import collapse.
    trailingCommentSplitTypes: new Set(['import_list']),
    wrapperTypes: {},
    kindLabels: {
      function_declaration: 'function',
      // tree-sitter-kotlin parses class, interface and enum headers all as
      // class_declaration — "type declaration" is the honest word for the union.
      class_declaration: 'type declaration',
      object_declaration: 'object',
      property_declaration: 'property',
      type_alias: 'type alias',
      package_header: 'package header',
      import_list: 'import list',
      shebang_line: 'shebang',
    },
  },
  // No def kinds: tree-sitter-kotlin's declarations carry no identifier `name`
  // field the extraction walk can read, so kotlin symbols are omitted, not guessed.
  repomap: {
    defKinds: {},
    refTypes: ['simple_identifier', 'type_identifier'],
  },
};
