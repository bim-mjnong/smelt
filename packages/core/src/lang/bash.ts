import type { LanguageProfile } from './profile.ts';

export const bash: LanguageProfile = {
  id: 'bash',
  extensions: ['sh', 'bash'],
  wasm: 'tree-sitter-bash.wasm',
  markerLeader: '# ',
  structure: {
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    // The shebang decides which interpreter runs the file. It parses as an ordinary
    // comment node, so it is pinned the way go's build tag is — never collapsed.
    pinnedCommentPattern: /^#!/,
    wrapperTypes: {},
    kindLabels: {
      function_definition: 'function',
      command: 'command',
      variable_assignment: 'variable assignment',
      declaration_command: 'variable assignment',
      comment: 'comment',
    },
  },
  // No def kinds: bash function names are `word` nodes, not identifiers, so they are
  // omitted from the map rather than guessed at.
  repomap: {
    defKinds: {},
    refTypes: ['variable_name'],
  },
};
