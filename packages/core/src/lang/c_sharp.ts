import type { LanguageProfile } from './profile.ts';

export const c_sharp: LanguageProfile = {
  id: 'c_sharp',
  extensions: ['cs'],
  wasm: 'tree-sitter-c_sharp.wasm',
  markerLeader: '// ',
  structure: {
    // `///` doc comments and `//` line comments are both plain comment nodes.
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    wrapperTypes: {},
    kindLabels: {
      class_declaration: 'class',
      interface_declaration: 'interface',
      struct_declaration: 'struct',
      enum_declaration: 'enum',
      record_declaration: 'record',
      delegate_declaration: 'delegate',
      namespace_declaration: 'namespace',
      file_scoped_namespace_declaration: 'namespace',
      using_directive: 'using directive',
      global_statement: 'statement',
    },
  },
  repomap: {
    defKinds: {
      class_declaration: 'class',
      interface_declaration: 'interface',
      struct_declaration: 'struct',
      enum_declaration: 'enum',
      record_declaration: 'record',
      delegate_declaration: 'delegate',
      method_declaration: 'method',
    },
    refTypes: ['identifier'],
  },
};
