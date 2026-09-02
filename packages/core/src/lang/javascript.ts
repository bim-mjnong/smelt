import type { LanguageProfile } from './profile.ts';
import { TS_DEF_KINDS, TS_REF_TYPES } from './typescript.ts';

export const javascript: LanguageProfile = {
  id: 'javascript',
  extensions: ['js', 'mjs', 'cjs', 'jsx'],
  wasm: 'tree-sitter-javascript.wasm',
  markerLeader: '// ',
  structure: {
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    // `#!/usr/bin/env node` parses as a hash_bang_line node, and it decides how the
    // file executes — a collapse that swallowed it would break every direct invocation.
    pinnedTypes: new Set(['hash_bang_line']),
    wrapperTypes: { export_statement: 'export' },
    kindLabels: {
      function_declaration: 'function',
      generator_function_declaration: 'function',
      class_declaration: 'class',
      lexical_declaration: 'variable',
      variable_declaration: 'variable',
      import_statement: 'import statement',
      expression_statement: 'statement',
      hash_bang_line: 'shebang',
      comment: 'comment',
    },
  },
  repomap: { defKinds: TS_DEF_KINDS, refTypes: TS_REF_TYPES },
};
