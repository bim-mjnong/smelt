import { Parser } from 'web-tree-sitter';
import type { Node, Tree } from 'web-tree-sitter';

import { markerForLanguage, MARKER_LINE_COMMENT_LEADERS } from '../apply.ts';
import { GrammarUnavailableError } from '../errors.ts';
import { HASH_LENGTH } from '../hash.ts';
import type { ElisionPlan, PlanInput, PlannedElision, Planner } from '../types.ts';

import { loadGrammar } from './grammar.ts';

export const STRUCTURAL_PLANNER_ID = 'structural/v1';

/**
 * The languages this planner actually parses. Slice 2 scoped it to two grammars;
 * Slice 4 added rust, python and go, and Slice 4b added the ten prebuilt grammars
 * below — the same machinery, ten more node-kind sets. A language appears here only
 * once its node kinds are mapped in {@link STRUCTURE_BY_LANGUAGE}, because claiming a
 * language before that would produce markers that mislabel what they collapsed.
 *
 * Exported for the totality guard (`test/guards/structural-totality.test.ts`): every
 * language named here must have a fixture, a snapshot and a doc-comment case, so a
 * language cannot be claimed without tests.
 */
export const STRUCTURAL_LANGUAGES = [
  'typescript',
  'tsx',
  'javascript',
  'rust',
  'python',
  'go',
  'java',
  'c',
  'cpp',
  'c_sharp',
  'ruby',
  'php',
  'kotlin',
  'swift',
  'bash',
] as const;
export type StructuralLanguage = (typeof STRUCTURAL_LANGUAGES)[number];

/**
 * Every elision this planner produces carries this rule id, and the profitability
 * check below renders the marker that rule would earn — so the two must not drift.
 */
const SIBLING_COLLAPSE_RULE = 'sibling-collapse';

/**
 * A stand-in hash of the real length, so the profitability check can render the
 * marker a cut would earn before the cut exists. Marker cost depends on the hash's
 * *length*, never its value.
 */
const PLACEHOLDER_HASH = '0'.repeat(HASH_LENGTH);

export interface StructuralPlannerOptions {
  /**
   * Never collapse a sibling group smaller than this. Defaults to 1 — the byte
   * profitability check already refuses collapses that would not pay for their marker.
   */
  readonly minSiblings?: number;
  /** Focus matching is substring, case-insensitive by default — same as lexical. */
  readonly caseSensitive?: boolean;
}

/**
 * One top-level declaration, together with the doc comment attached to it. The unit is
 * the atom of every decision here: a unit is kept whole or collapsed whole, which is
 * what makes "a kept declaration keeps its signature line and attached doc comment"
 * true by construction rather than by patching ranges afterwards.
 *
 * All positions are UTF-16 code-unit indices (what web-tree-sitter reports for a JS
 * string); they are converted to UTF-8 byte offsets in one place, at the end.
 */
interface Unit {
  /** Start of the unit — the first attached comment or attribute if there is one. */
  readonly start: number;
  /** End of the declaration node. */
  readonly end: number;
  /** Human word for the declaration's kind, e.g. `'function'`. */
  readonly kind: string;
  /**
   * A unit the planner must never collapse, matched or not. Three languages use it:
   * go's `//go:build` constraint governs the whole file yet can never *attach* to a
   * declaration (the Go spec requires a blank line after it); shebang lines (bash,
   * ruby) and ruby's `# frozen_string_literal:` magic comment govern how the file is
   * executed at all; and php's `<?php` open tag is what makes the rest of the file
   * php. Collapsing any of them silently changes what the survivor *is*.
   */
  readonly pinned?: boolean;
}

/**
 * The structural planner — the reason smelt exists.
 *
 * It parses with the language's tree-sitter grammar, finds the top-level declarations
 * whose text matches the caller's focus, keeps each match whole — signature line,
 * attached doc comment, body — and collapses each contiguous run of non-matching
 * *siblings* into one marker that names them from the parse tree: `collapsed 3 sibling
 * functions`. Structure is what makes that explanation possible; a line window can only
 * ever say "collapsed 40 lines".
 *
 * It throws {@link GrammarUnavailableError} rather than falling back to the lexical
 * planner, and that is the deliberate part. A silent fallback would mean a caller who
 * asked for structural planning, and whose grammar failed to load, gets line-window
 * output labelled `structural/v1` — plausible, wrong, and undetectable from the
 * outside. A caller who wants the fallback asks for it, by planning lexically itself.
 */
export class StructuralPlanner implements Planner {
  readonly id = STRUCTURAL_PLANNER_ID;
  readonly options: StructuralPlannerOptions;

  constructor(options: StructuralPlannerOptions = {}) {
    this.options = options;
  }

  plan(input: PlanInput): Promise<ElisionPlan> {
    return planStructural(input, this.options);
  }
}

/**
 * The planner as a function, exported like {@link planLexical} so it can be tested and
 * reused directly. Deterministic: same text, same language, same focus, same options —
 * byte-identical plan.
 *
 * `budgetBytes` is a target, not a guarantee, for the same reason it is in the lexical
 * planner: once every non-matching sibling run is collapsed there is nothing left to
 * cut except the declarations the caller asked to keep, and an optimizer that silently
 * drops the thing you searched for is the exact failure this design refuses. Callers
 * who need a hard ceiling check `outputBytes` and decide.
 *
 * @throws {GrammarUnavailableError} when the language is not one this planner parses,
 *   when the grammar cannot be loaded, or when the parser produces no tree. Never a
 *   lexical fallback.
 */
export async function planStructural(
  input: PlanInput,
  options: StructuralPlannerOptions = {},
): Promise<ElisionPlan> {
  const language = assertStructuralLanguage(input.language);
  const grammar = await loadGrammar(language);

  const parser = new Parser();
  let tree: Tree | null = null;
  try {
    parser.setLanguage(grammar);
    tree = parser.parse(input.text);
    if (tree === null) {
      throw new GrammarUnavailableError(
        `smelt: the ${language} parser returned no tree. Structural planning cannot ` +
          `proceed, and it does not fall back to lexical — a caller who wants the ` +
          `fallback plans lexically itself.`,
      );
    }
    return {
      planner: STRUCTURAL_PLANNER_ID,
      language: input.language,
      elisions: planFromTree(tree, input, options, language),
    };
  } finally {
    tree?.delete();
    parser.delete();
  }
}

function assertStructuralLanguage(language: PlanInput['language']): StructuralLanguage {
  for (const supported of STRUCTURAL_LANGUAGES) {
    if (language === supported) return supported;
  }
  const named = `${STRUCTURAL_LANGUAGES.slice(0, -1).join(', ')} and ${
    STRUCTURAL_LANGUAGES[STRUCTURAL_LANGUAGES.length - 1]
  }`;
  throw new GrammarUnavailableError(
    `smelt: structural planning covers ${named} in this ` +
      `slice; got "${language}". It does not fall back to the lexical planner — output ` +
      `labelled structural/v1 that is really line windows would be undetectable from ` +
      `the outside. Use the lexical planner explicitly if that is what you want.`,
  );
}

function planFromTree(
  tree: Tree,
  input: PlanInput,
  options: StructuralPlannerOptions,
  language: StructuralLanguage,
): readonly PlannedElision[] {
  const structure = STRUCTURE_BY_LANGUAGE[language];
  const buildMarker = markerForLanguage(language);
  // When the marker lands as a line comment (python), it comments out everything to the
  // end of its line — so a collapse is only legal where nothing kept follows on the
  // marker's own line. See the flush below.
  const markerIsLineComment = MARKER_LINE_COMMENT_LEADERS[language] !== undefined;
  const units = unitsOf(tree.rootNode, input.text, structure);
  const matched = matchUnits(units, input, options);
  const minSiblings = options.minSiblings ?? 1;
  const toByte = utf8OffsetIndex(
    input.text,
    units.flatMap((unit) => [unit.start, unit.end]),
  );

  const elisions: PlannedElision[] = [];
  let run: Unit[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const group = run;
    run = [];
    if (group.length < minSiblings) return;
    // A line-comment marker swallows the rest of its line. When the run's last unit
    // ends mid-line — python's `stmt_a(); stmt_b()` puts two top-level statements on
    // one line — the marker's `# ` leader would comment out the *kept* code after it.
    // Refusing the collapse is the honest move; extending the range would elide code
    // no unit accounted for.
    if (markerIsLineComment && !restOfLineIsBlank(input.text, group[group.length - 1]!.end)) {
      return;
    }
    const start = toByte.get(group[0]!.start)!;
    const end = toByte.get(group[group.length - 1]!.end)!;
    const cutBytes = end - start;
    const explanation = explain(group);
    // Profitability, measured rather than estimated: render the exact marker this cut
    // would earn — the explanation's length varies with kind diversity and the
    // language's marker may carry a comment leader (see markerForLanguage), so a fixed
    // estimate can pass a cut whose marker is bigger than what it removes, and a
    // marker that costs more than it removes grows the output.
    const markerBytes = Buffer.byteLength(
      buildMarker({
        hash: PLACEHOLDER_HASH,
        bytes: cutBytes,
        rule: SIBLING_COLLAPSE_RULE,
        explanation,
      }),
      'utf8',
    );
    if (cutBytes <= markerBytes) return;
    elisions.push({
      range: { start, end },
      reason: { rule: SIBLING_COLLAPSE_RULE, explanation },
    });
  };

  for (let i = 0; i < units.length; i += 1) {
    if (matched[i] === true || units[i]!.pinned === true) {
      flush();
    } else {
      run.push(units[i]!);
    }
  }
  flush();
  return elisions;
}

/** True when nothing but whitespace follows `index` on its own line. */
function restOfLineIsBlank(text: string, index: number): boolean {
  for (let i = index; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\n') return true;
    if (!/\s/.test(ch)) return false;
  }
  return true;
}

/**
 * Group the root's named children into units: each declaration plus the comment block
 * — and, in rust, the outer attributes — attached to it. A comment attaches when only
 * blank-free whitespace separates it from what follows — one newline at most — so a doc
 * comment travels with its declaration, while a comment left floating above a blank
 * line stands alone.
 *
 * Attributes attach *unconditionally*: tree-sitter-rust parses `#[inline]` as a
 * top-level sibling of the item it decorates, but the language's own rule is that an
 * outer attribute modifies the next item, blank lines or not. So once an attribute is
 * pending, the whole pending prefix (doc comments included) rides forward to the next
 * declaration — treating it as its own unit would let a collapse strip `#[derive(…)]`
 * and the doc comment above it off a kept declaration.
 */
function unitsOf(root: Node, text: string, structure: LanguageStructure): readonly Unit[] {
  const units: Unit[] = [];
  /** Comments and attributes waiting to attach to the next declaration. */
  let pending: Node[] = [];
  /** Once true, blank lines no longer detach the pending prefix — see above. */
  let pendingHasAttribute = false;

  const flushPending = (): void => {
    if (pending.length === 0) return;
    units.push({
      start: pending[0]!.startIndex,
      end: pending[pending.length - 1]!.endIndex,
      kind: pendingHasAttribute ? 'attribute' : 'comment',
      pinned: !pendingHasAttribute && pending.some((node) => pinnedComment(node, text, structure)),
    });
    pending = [];
    pendingHasAttribute = false;
  };

  for (const child of root.namedChildren) {
    if (child === null) continue;
    if (structure.pinnedTypes?.has(child.type) === true) {
      // A pinned node type (php's `<?php` tag, javascript's `#!` line) is its own
      // uncollapsible unit — nothing attaches to it, and no run may swallow it.
      flushPending();
      units.push({
        start: child.startIndex,
        end: child.endIndex,
        kind: kindOf(child, structure),
        pinned: true,
      });
      continue;
    }
    const isComment = structure.commentTypes.has(child.type);
    const isAttribute = structure.attributeTypes.has(child.type);
    if (isComment || isAttribute) {
      if (
        pending.length > 0 &&
        !pendingHasAttribute &&
        !adjacent(text, pending[pending.length - 1]!.endIndex, child.startIndex)
      ) {
        flushPending();
      }
      pending.push(child);
      pendingHasAttribute ||= isAttribute;
      continue;
    }

    const attached =
      pending.length > 0 &&
      (pendingHasAttribute ||
        adjacent(text, pending[pending.length - 1]!.endIndex, child.startIndex));
    if (attached && pending.some((node) => pinnedComment(node, text, structure))) {
      // A pinned comment (`//go:build`) governs the file, not the declaration it
      // happens to touch — keep it a standalone, uncollapsible unit either way.
      flushPending();
      units.push({
        start: child.startIndex,
        end: child.endIndex,
        kind: kindOf(child, structure),
      });
    } else if (attached) {
      units.push({
        start: pending[0]!.startIndex,
        end: child.endIndex,
        kind: kindOf(child, structure),
      });
      pending = [];
      pendingHasAttribute = false;
    } else {
      flushPending();
      units.push({
        start: child.startIndex,
        end: child.endIndex,
        kind: kindOf(child, structure),
      });
    }
  }
  flushPending();
  return units;
}

/** Whether this comment node is one the language pins to the file. See {@link Unit}. */
function pinnedComment(node: Node, text: string, structure: LanguageStructure): boolean {
  if (structure.pinnedCommentPattern === undefined) return false;
  if (!structure.commentTypes.has(node.type)) return false;
  return structure.pinnedCommentPattern.test(text.slice(node.startIndex, node.endIndex));
}

/** Nothing but whitespace between the two indices, and at most one newline. */
function adjacent(text: string, end: number, start: number): boolean {
  const between = text.slice(end, start);
  if (!/^\s*$/.test(between)) return false;
  return (between.match(/\n/g) ?? []).length <= 1;
}

function matchUnits(
  units: readonly Unit[],
  input: PlanInput,
  options: StructuralPlannerOptions,
): readonly boolean[] {
  const caseSensitive = options.caseSensitive ?? false;
  const focus = (input.focus ?? []).filter((term) => term.length > 0);
  const needles = caseSensitive ? focus : focus.map((term) => term.toLowerCase());

  return units.map((unit) => {
    if (needles.length === 0) return false;
    const raw = input.text.slice(unit.start, unit.end);
    const haystack = caseSensitive ? raw : raw.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
}

/**
 * Law 2, for this rule: the explanation names the *kind* and the *count*, read off the
 * parse tree — `collapsed 3 sibling functions` — never a line count as the claim. A
 * mixed run says what it mixed: `collapsed 4 sibling declarations (3 functions,
 * 1 class)` — and when the run holds anything that is not a declaration (a statement,
 * a floating comment, an unparsed region), the heading says `nodes`, because calling
 * a parse error a declaration would be the marker lying about the tree.
 */
function explain(group: readonly Unit[]): string {
  const counts = new Map<string, number>();
  for (const unit of group) counts.set(unit.kind, (counts.get(unit.kind) ?? 0) + 1);

  const total = group.length;
  if (counts.size === 1) {
    const kind = group[0]!.kind;
    return `collapsed ${String(total)} sibling ${countNoun(kind, total)}`;
  }
  const parts = [...counts.entries()].map(
    ([kind, count]) => `${String(count)} ${countNoun(kind, count)}`,
  );
  const heading = [...counts.keys()].every((kind) => !NON_DECLARATION_KINDS.has(kind))
    ? 'declarations'
    : 'nodes';
  return `collapsed ${String(total)} sibling ${heading} (${parts.join(', ')})`;
}

/** The kind labels that are not declarations, so a mixed heading never overclaims. */
const NON_DECLARATION_KINDS: ReadonlySet<string> = new Set([
  'statement',
  'comment',
  'unparsed region',
  'package clause',
  'package header',
  'package declaration',
  'attribute',
  'command',
  'variable assignment',
  'include directive',
  'shebang',
  'php tag',
]);

function countNoun(kind: string, count: number): string {
  if (count === 1) return kind;
  return /(?:s|sh|ch)$/.test(kind) ? `${kind}es` : `${kind}s`;
}

/**
 * Human words for the tree-sitter node types this planner expects at the top level of
 * a TypeScript or TSX file. What the map does not name, {@link kindOf} still labels
 * honestly: an `ERROR` node is an `'unparsed region'`, any other statement kind is a
 * `'statement'`, and only what remains is called a `'declaration'` — a marker that
 * calls a parse error or a log line a declaration would be lying about the tree.
 */
const TS_KIND_LABELS: Readonly<Record<string, string>> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_signature: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type alias',
  enum_declaration: 'enum',
  lexical_declaration: 'variable',
  variable_declaration: 'variable',
  import_statement: 'import statement',
  internal_module: 'namespace',
  module: 'namespace',
  ambient_declaration: 'ambient declaration',
  expression_statement: 'statement',
  comment: 'comment',
};

/**
 * What this planner needs to know about a language, beyond its grammar: which node
 * types are comments (so a doc comment travels with its declaration), which node types
 * merely wrap the declaration that should be named (`export function f()` is a
 * function, `@cached def f()` is a function), and the human word for each top-level
 * node kind. One entry per {@link StructuralLanguage} — the `Record` keeps the two
 * lists total, so adding a language without mapping its kinds is a compile error.
 */
interface LanguageStructure {
  /** Top-level node types that are comments, in this grammar's vocabulary. */
  readonly commentTypes: ReadonlySet<string>;
  /**
   * Top-level node types that are outer attributes — parsed as siblings of the item
   * they decorate, but attached forward to it unconditionally by {@link unitsOf},
   * because that is what the attribute means in the language.
   */
  readonly attributeTypes: ReadonlySet<string>;
  /**
   * Comments matching this pattern are pinned to the file — never attached, never
   * collapsed. Go's `//go:build` governs which builds see the whole file, and the
   * spec's mandatory blank line after it means it could never attach; bash and ruby
   * shebang lines, and ruby's `# frozen_string_literal:` magic comment, govern how
   * the file executes at all.
   */
  readonly pinnedCommentPattern?: RegExp;
  /**
   * Non-comment node types pinned to the file the same way — php's `<?php` open tag,
   * javascript's `#!` hash-bang line. Each is its own uncollapsible unit: a run that
   * swallowed one would change what the survivor *is*, not just what it contains.
   */
  readonly pinnedTypes?: ReadonlySet<string>;
  /**
   * Node types that wrap the declaration worth naming — the marker should say what is
   * inside, not name the wrapper. The value is the label to fall back to when nothing
   * nameable is found inside.
   */
  readonly wrapperTypes: Readonly<Record<string, string>>;
  /** Human words per node type. See {@link TS_KIND_LABELS} for the labelling rules. */
  readonly kindLabels: Readonly<Record<string, string>>;
}

const TS_STRUCTURE: LanguageStructure = {
  commentTypes: new Set(['comment']),
  attributeTypes: new Set(),
  wrapperTypes: { export_statement: 'export' },
  kindLabels: TS_KIND_LABELS,
};

const STRUCTURE_BY_LANGUAGE: Readonly<Record<StructuralLanguage, LanguageStructure>> = {
  typescript: TS_STRUCTURE,
  tsx: TS_STRUCTURE,
  javascript: {
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
  rust: {
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
  python: {
    // Docstrings are not comments — they live inside the definition's body, so a kept
    // definition keeps its docstring because units are kept whole. `#` comments above
    // a definition attach the same way `/** … */` does in TypeScript.
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
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
  go: {
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    // `//go:build` (and the legacy `// +build`) constrain the whole file's builds.
    pinnedCommentPattern: /^\/\/(go:build|\s*\+build)\s/,
    wrapperTypes: {},
    kindLabels: {
      function_declaration: 'function',
      method_declaration: 'method',
      type_declaration: 'type declaration',
      const_declaration: 'constant',
      var_declaration: 'variable',
      import_declaration: 'import declaration',
      package_clause: 'package clause',
    },
  },
  java: {
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
  c: {
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    wrapperTypes: {},
    kindLabels: {
      function_definition: 'function',
      declaration: 'declaration',
      struct_specifier: 'struct',
      union_specifier: 'union',
      enum_specifier: 'enum',
      type_definition: 'type definition',
      preproc_include: 'include directive',
      preproc_def: 'macro definition',
      preproc_function_def: 'macro definition',
    },
  },
  cpp: {
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    // `template <typename T> class Box {}` — the marker should say what the template
    // declares, not just that it is a template.
    wrapperTypes: { template_declaration: 'template' },
    kindLabels: {
      function_definition: 'function',
      declaration: 'declaration',
      struct_specifier: 'struct',
      class_specifier: 'class',
      union_specifier: 'union',
      enum_specifier: 'enum',
      type_definition: 'type definition',
      alias_declaration: 'type alias',
      namespace_definition: 'namespace',
      using_declaration: 'using declaration',
      linkage_specification: 'extern block',
      preproc_include: 'include directive',
      preproc_def: 'macro definition',
      preproc_function_def: 'macro definition',
    },
  },
  c_sharp: {
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
  ruby: {
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    // The shebang and the `# frozen_string_literal:` magic comment both govern how
    // the whole file executes; neither may collapse into a run.
    pinnedCommentPattern: /^#(?:!|\s*frozen_string_literal:)/,
    wrapperTypes: {},
    kindLabels: {
      method: 'method',
      singleton_method: 'method',
      class: 'class',
      module: 'module',
      // Top-level `require "json"` and `CONSTANT = 1` are expression nodes in
      // tree-sitter-ruby; "statement" is the honest generic word for both.
      call: 'statement',
      assignment: 'statement',
      comment: 'comment',
    },
  },
  php: {
    // `//`, `#` and `/** … */` PHPDoc are all comment nodes.
    commentTypes: new Set(['comment']),
    attributeTypes: new Set(),
    // `<?php` is what makes the rest of the file php at all.
    pinnedTypes: new Set(['php_tag']),
    wrapperTypes: {},
    kindLabels: {
      function_definition: 'function',
      class_declaration: 'class',
      interface_declaration: 'interface',
      trait_declaration: 'trait',
      enum_declaration: 'enum',
      const_declaration: 'constant',
      namespace_definition: 'namespace',
      namespace_use_declaration: 'use declaration',
      expression_statement: 'statement',
      php_tag: 'php tag',
    },
  },
  kotlin: {
    // `//` is line_comment; `/** … */` KDoc is multiline_comment.
    commentTypes: new Set(['line_comment', 'multiline_comment']),
    attributeTypes: new Set(),
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
    },
  },
  swift: {
    // `//` and `///` are comment nodes; `/* … */` is multiline_comment.
    commentTypes: new Set(['comment', 'multiline_comment']),
    attributeTypes: new Set(),
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
    },
  },
  bash: {
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
};

/**
 * The kind of a declaration, unwrapping wrappers (`export …`, `@decorator`) so the
 * marker names what it hides. What the language's map does not name is still labelled
 * honestly — see {@link TS_KIND_LABELS}.
 */
function kindOf(node: Node, structure: LanguageStructure): string {
  const wrapperFallback = structure.wrapperTypes[node.type];
  if (wrapperFallback !== undefined) {
    for (const child of node.namedChildren) {
      if (child === null || structure.commentTypes.has(child.type)) continue;
      const label = structure.kindLabels[child.type];
      if (label !== undefined) return label;
    }
    return wrapperFallback;
  }
  const label = structure.kindLabels[node.type];
  if (label !== undefined) return label;
  if (node.type === 'ERROR') return 'unparsed region';
  if (node.type.endsWith('_statement') || node.type === 'statement_block') return 'statement';
  return 'declaration';
}

/**
 *
 * web-tree-sitter reports positions in code units of the JS string it parsed;
 * {@link ElisionPlan} ranges are UTF-8 bytes. Because every converted index is a parse
 * node boundary, a range can never split a multi-byte character — a node boundary is
 * always a character boundary. One forward pass, so the conversion is linear.
 */
function utf8OffsetIndex(text: string, indices: readonly number[]): ReadonlyMap<number, number> {
  const sorted = [...new Set(indices)].toSorted((a, b) => a - b);
  const map = new Map<number, number>();
  let previousIndex = 0;
  let previousByte = 0;
  for (const index of sorted) {
    previousByte += Buffer.byteLength(text.slice(previousIndex, index), 'utf8');
    previousIndex = index;
    map.set(index, previousByte);
  }
  return map;
}
