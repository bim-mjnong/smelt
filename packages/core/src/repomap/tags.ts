import { Parser } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';

import { GrammarUnavailableError } from '../errors.ts';
import { loadGrammar } from '../plan/grammar.ts';
import type { LanguageId } from '../types.ts';

/**
 * Definition/reference tag extraction for the repo map — one file at a time, through
 * the same bundled tree-sitter grammars the structural planner uses.
 *
 * Modelled on Aider's repo-map tags (https://aider.chat/docs/repomap.html): a *def* is
 * a named declaration read off the parse tree, a *ref* is an identifier occurrence.
 * Aider extracts both with per-language `.scm` query files; here the same facts come
 * from a manual tree walk over per-language node-kind tables, so no query assets are
 * added. The design is Aider's, not this project's.
 *
 * Honest scope, stated rather than implied: refs count `identifier`/`type_identifier`
 * nodes only, so a member access like `config.load()` contributes `config`, not
 * `load` — method references travel through the object they are called on. A def whose
 * name is a destructuring pattern is skipped rather than guessed at.
 */

/** One named definition, read off the parse tree. `line` is 1-based. */
export interface DefinitionTag {
  readonly name: string;
  /** Human word for the node kind, e.g. `'function'` — same register as the planners. */
  readonly kind: string;
  readonly line: number;
}

/** One referenced identifier and how many times this file references it. */
export interface ReferenceTag {
  readonly name: string;
  readonly count: number;
}

/** Everything the repo map needs to know about one file. */
export interface FileTags {
  /** In document order. */
  readonly defs: readonly DefinitionTag[];
  /** Sorted by name, so the extraction is deterministic end to end. */
  readonly refs: readonly ReferenceTag[];
}

/**
 * Declaration node type → human kind word, per language. A node type absent from its
 * language's table is simply not a definition — no guessing.
 */
const TS_DEF_KINDS: Readonly<Record<string, string>> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_signature: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type alias',
  enum_declaration: 'enum',
  method_definition: 'method',
  variable_declarator: 'variable',
};

const DEF_KINDS: Readonly<Record<LanguageId, Readonly<Record<string, string>>>> = {
  typescript: TS_DEF_KINDS,
  tsx: TS_DEF_KINDS,
  javascript: TS_DEF_KINDS,
  rust: {
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
  python: {
    function_definition: 'function',
    class_definition: 'class',
  },
  go: {
    function_declaration: 'function',
    method_declaration: 'method',
    type_spec: 'type',
  },
  // The slice-4b tables below list only node kinds whose `name` field is an
  // *identifier* node, because that is what the extraction walk reads — a kind whose
  // name is spelled differently (php's `name` nodes, ruby's `constant` class names,
  // bash's `word` function names, kotlin's field-less declarations) is *omitted*, not
  // guessed at. An omitted kind means fewer symbols on the map, never wrong ones.
  java: {
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    record_declaration: 'record',
    annotation_type_declaration: 'annotation type',
    method_declaration: 'method',
  },
  c: {
    struct_specifier: 'struct',
    union_specifier: 'union',
    enum_specifier: 'enum',
  },
  cpp: {
    class_specifier: 'class',
    struct_specifier: 'struct',
    union_specifier: 'union',
    enum_specifier: 'enum',
    namespace_definition: 'namespace',
  },
  c_sharp: {
    class_declaration: 'class',
    interface_declaration: 'interface',
    struct_declaration: 'struct',
    enum_declaration: 'enum',
    record_declaration: 'record',
    delegate_declaration: 'delegate',
    method_declaration: 'method',
  },
  ruby: {
    method: 'method',
    singleton_method: 'method',
  },
  php: {},
  kotlin: {},
  swift: {
    class_declaration: 'type',
    protocol_declaration: 'protocol',
    function_declaration: 'function',
  },
  bash: {},
};

/** Node types counted as references, per language. */
const REF_TYPES: Readonly<Record<LanguageId, readonly string[]>> = {
  typescript: ['identifier', 'type_identifier'],
  tsx: ['identifier', 'type_identifier'],
  javascript: ['identifier', 'type_identifier'],
  rust: ['identifier', 'type_identifier'],
  python: ['identifier'],
  go: ['identifier', 'type_identifier'],
  java: ['identifier', 'type_identifier'],
  c: ['identifier', 'type_identifier'],
  cpp: ['identifier', 'type_identifier'],
  c_sharp: ['identifier'],
  ruby: ['identifier', 'constant'],
  php: ['name', 'variable_name'],
  kotlin: ['simple_identifier', 'type_identifier'],
  swift: ['simple_identifier', 'type_identifier'],
  bash: ['variable_name'],
};

/**
 * C/C++ specifier node types that name a *usage site* as readily as a definition:
 * `struct point p;` parses as a `struct_specifier` with a `name` and no `body`, same
 * as the `struct point { … };` that actually defines it. Only the bodied form is a
 * definition. Without this check a mere mention earns a `defined at` receipt, *and*
 * its name node lands in `defNameStarts` — so the real definition's cross-file
 * references silently vanish from the map.
 */
const BODY_REQUIRED_TYPES: ReadonlySet<string> = new Set([
  'struct_specifier',
  'union_specifier',
  'enum_specifier',
  'class_specifier',
]);

/**
 * A local `const x = …` inside a function body is not a map-worthy symbol. A
 * `variable_declarator` counts as a definition only at module top level — directly
 * under the program node, or under an `export` statement that is.
 */
function isDefinitionSite(node: Node): boolean {
  if (BODY_REQUIRED_TYPES.has(node.type) && node.childForFieldName('body') === null) {
    return false; // a bodiless specifier is a usage or forward declaration, not a definition
  }
  if (node.type !== 'variable_declarator') return true;
  const container = node.parent?.parent;
  if (container === null || container === undefined) return false;
  if (container.type === 'program') return true;
  return container.type === 'export_statement' && container.parent?.type === 'program';
}

/**
 * Extract definition and reference tags from one file.
 *
 * Deterministic: same text, same language, identical tags — defs in document order,
 * refs sorted by name. A def's own name node is not counted as a reference to itself.
 *
 * @throws {GrammarUnavailableError} when the grammar cannot load or produces no tree.
 *   Never a lexical guess — same no-fallback rule as the structural planner.
 */
export async function extractTags(text: string, language: LanguageId): Promise<FileTags> {
  const grammar = await loadGrammar(language);
  const defKinds = DEF_KINDS[language];
  const refTypes = REF_TYPES[language];

  const parser = new Parser();
  let tree = null;
  try {
    parser.setLanguage(grammar);
    tree = parser.parse(text);
    if (tree === null) {
      throw new GrammarUnavailableError(
        `smelt: the ${language} parser returned no tree, so no tags can be extracted. ` +
          `Refusing to guess at definitions that were never parsed.`,
      );
    }

    const defs: DefinitionTag[] = [];
    const refCounts = new Map<string, number>();
    /** Start indices of def-name nodes, so a definition never references itself. */
    const defNameStarts = new Set<number>();

    // Depth-first, document order, via an explicit stack — recursion depth on a real
    // file is the tree's depth, which nothing bounds.
    const stack: Node[] = [tree.rootNode];
    while (stack.length > 0) {
      const node = stack.pop()!;

      const kind = defKinds[node.type];
      if (kind !== undefined && isDefinitionSite(node)) {
        const nameNode = node.childForFieldName('name');
        // Only a plain identifier names a def; a destructuring pattern is skipped, not
        // guessed at.
        if (nameNode !== null && nameNode.type.endsWith('identifier')) {
          defs.push({ name: nameNode.text, kind, line: node.startPosition.row + 1 });
          defNameStarts.add(nameNode.startIndex);
        }
      }

      if (refTypes.includes(node.type) && !defNameStarts.has(node.startIndex)) {
        refCounts.set(node.text, (refCounts.get(node.text) ?? 0) + 1);
      }

      const children = node.namedChildren;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (child !== null && child !== undefined) stack.push(child);
      }
    }

    const refs = [...refCounts.entries()]
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, count]) => ({ name, count }));

    return { defs, refs };
  } finally {
    tree?.delete();
    parser.delete();
  }
}
