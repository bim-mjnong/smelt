import type { LanguageProfile } from './profile.ts';

export const swift: LanguageProfile = {
  id: 'swift',
  extensions: ['swift'],
  wasm: 'tree-sitter-swift.wasm',
  markerLeader: '// ',
  structure: {
    // `//` and `///` are comment nodes; `/* … */` is multiline_comment.
    commentTypes: new Set(['comment', 'multiline_comment']),
    attributeTypes: new Set(),
    // `#!/usr/bin/env swift` parses as a shebang_line node; same law as the rest.
    pinnedTypes: new Set(['shebang_line']),
    wrapperTypes: {},
    kindLabels: {
      function_declaration: 'function',
      // tree-sitter-swift parses struct, class, enum and extension declarations all
      // as class_declaration — "type declaration" is the honest word for the union.
      class_declaration: 'type declaration',
      protocol_declaration: 'protocol',
      property_declaration: 'property',
      typealias_declaration: 'type alias',
      import_declaration: 'import declaration',
      shebang_line: 'shebang',
    },
  },
  repomap: {
    defKinds: {
      class_declaration: 'type',
      protocol_declaration: 'protocol',
      function_declaration: 'function',
    },
    refTypes: ['simple_identifier', 'type_identifier'],
  },
};
