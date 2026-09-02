import type { LanguageProfile } from './profile.ts';

export const ruby: LanguageProfile = {
  id: 'ruby',
  extensions: ['rb'],
  wasm: 'tree-sitter-ruby.wasm',
  markerLeader: '# ',
  structure: {
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    // The shebang and the `# frozen_string_literal:` magic comment both govern how
    // the whole file executes; neither may collapse into a run.
    pinnedCommentPattern: /^#(?:!|\s*frozen_string_literal:)/,
    // A heredoc's body is a top-level sibling of the statement holding its opener —
    // it extends that statement's unit, or a collapse could keep the opener and cut
    // the body, leaving an unterminated heredoc that swallows every declaration
    // after it (and tree-sitter-ruby reports no ERROR for it at EOF).
    ridesBackwardTypes: new Set(['heredoc_body']),
    wrapperTypes: {},
    kindLabels: {
      method: 'method',
      singleton_method: 'method',
      class: 'class',
      module: 'module',
      // Top-level `require "json"` and `CONSTANT = 1` are expression nodes in
      // tree-sitter-ruby; "statement" is the honest generic word for both — and for
      // top-level control-flow blocks, which are expressions here too.
      call: 'statement',
      assignment: 'statement',
      if: 'statement',
      unless: 'statement',
      case: 'statement',
      while: 'statement',
      until: 'statement',
      for: 'statement',
      begin: 'statement',
      heredoc_body: 'heredoc body',
      comment: 'comment',
    },
  },
  repomap: {
    defKinds: {
      method: 'method',
      singleton_method: 'method',
    },
    refTypes: ['identifier', 'constant'],
  },
};
