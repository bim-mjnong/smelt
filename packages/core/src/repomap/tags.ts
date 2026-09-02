import { Parser } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';

import { GrammarUnavailableError } from '../errors.ts';
import { profileFor } from '../lang/registry.ts';
import { loadGrammar } from '../plan/grammar.ts';
import type { LanguageId } from '../types.ts';

/**
 * Definition/reference tag extraction for the repo map — one file at a time, through
 * the same bundled tree-sitter grammars the structural planner uses.
 *
 * Modelled on Aider's repo-map tags (https://aider.chat/docs/repomap.html): a *def* is
 * a named declaration read off the parse tree, a *ref* is an identifier occurrence.
 * Aider extracts both with per-language `.scm` query files; here the same facts come
 * from a manual tree walk over each language's `repomap` profile section
 * (`src/lang/`), so no query assets are added. The design is Aider's, not this
 * project's.
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
  // The per-language facts live on the language's profile (`src/lang/`). A profile
  // without a repomap section contributes nothing — no symbols, never wrong ones.
  const repomap = profileFor(language).repomap;
  const defKinds = repomap?.defKinds ?? {};
  const refTypes = repomap?.refTypes ?? [];

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
