import type { LanguageProfile } from './profile.ts';

export const python: LanguageProfile = {
  id: 'python',
  extensions: ['py', 'pyi'],
  wasm: 'tree-sitter-python.wasm',
  markerLeader: '# ',
  structure: {
    // Docstrings are not comments — they live inside the definition's body, so a kept
    // definition keeps its docstring because units are kept whole. `#` comments above
    // a definition attach the same way `/** … */` does in TypeScript.
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    // `#!/usr/bin/env python3` parses as a plain comment node, but it decides which
    // interpreter runs the file — pinned the way the bash and ruby shebangs are.
    pinnedCommentPattern: /^#!/,
    wrapperTypes: { decorated_definition: 'declaration' },
    kindLabels: {
      function_definition: 'function',
      class_definition: 'class',
      import_statement: 'import statement',
      import_from_statement: 'import statement',
      future_import_statement: 'import statement',
      expression_statement: 'statement',
    },
  },
  repomap: {
    defKinds: {
      function_definition: 'function',
      class_definition: 'class',
    },
    refTypes: ['identifier'],
  },
};
