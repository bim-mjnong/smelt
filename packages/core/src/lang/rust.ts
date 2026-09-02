import type { LanguageProfile } from './profile.ts';

export const rust: LanguageProfile = {
  id: 'rust',
  extensions: ['rs'],
  wasm: 'tree-sitter-rust.wasm',
  markerLeader: '// ',
  structure: {
    // `///` and `//!` doc comments are line_comment nodes; `/** … */` is block_comment.
    commentTypes: new Set(['line_comment', 'block_comment']),
    // `#[…]` is a top-level sibling in tree-sitter-rust; it rides forward to its item.
    attributeTypes: new Set(['attribute_item']),
    wrapperTypes: {},
    kindLabels: {
      function_item: 'function',
      struct_item: 'struct',
      enum_item: 'enum',
      union_item: 'union',
      trait_item: 'trait',
      impl_item: 'impl block',
      mod_item: 'module',
      macro_definition: 'macro',
      type_item: 'type alias',
      const_item: 'constant',
      static_item: 'static item',
      use_declaration: 'use declaration',
      extern_crate_declaration: 'extern crate declaration',
      attribute_item: 'attribute',
      foreign_mod_item: 'extern block',
    },
  },
  repomap: {
    defKinds: {
      function_item: 'function',
      struct_item: 'struct',
      enum_item: 'enum',
      trait_item: 'trait',
      mod_item: 'module',
      const_item: 'constant',
      static_item: 'static',
      type_item: 'type alias',
      union_item: 'union',
    },
    refTypes: ['identifier', 'type_identifier'],
  },
};
