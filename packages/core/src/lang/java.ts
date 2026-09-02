import type { LanguageProfile } from './profile.ts';

export const java: LanguageProfile = {
  id: 'java',
  extensions: ['java'],
  wasm: 'tree-sitter-java.wasm',
  markerLeader: '// ',
  structure: {
    // `//` is line_comment, `/** … */` javadoc is block_comment — both attach.
    commentTypes: new Set(['line_comment', 'block_comment']),
    attributeTypes: new Set(),
    wrapperTypes: {},
    kindLabels: {
      class_declaration: 'class',
      interface_declaration: 'interface',
      enum_declaration: 'enum',
      record_declaration: 'record',
      annotation_type_declaration: 'annotation type',
      package_declaration: 'package declaration',
      import_declaration: 'import declaration',
      module_declaration: 'module declaration',
    },
  },
  repomap: {
    defKinds: {
      class_declaration: 'class',
      interface_declaration: 'interface',
      enum_declaration: 'enum',
      record_declaration: 'record',
      annotation_type_declaration: 'annotation type',
      method_declaration: 'method',
    },
    refTypes: ['identifier', 'type_identifier'],
  },
};
