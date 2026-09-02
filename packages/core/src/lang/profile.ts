import type { LanguageId } from '../types.ts';

/**
 * Everything smelt knows about one language, in one place.
 *
 * Before this module existed, a language's facts lived in seven tables across five
 * modules — the extension map in `detect.ts`, the grammar file in `plan/grammar.ts`,
 * the marker leader in `apply.ts`, the structural node kinds and pins in
 * `plan/structural.ts`, and the repo-map tag tables in `repomap/tags.ts`. Adding a
 * language meant editing all five, and forgetting one produced a language that half
 * works: detected but unparsable, parsable but with a syntax-breaking marker.
 *
 * A `LanguageProfile` is the single adapter carrying every per-language fact, and the
 * registry (`registry.ts`) is `Record<LanguageId, LanguageProfile>` so totality stays
 * a compile error: a new `LanguageId` without a profile does not build. Consumers
 * *read* the registry — none of them owns a slice of it.
 *
 * The optional sections state capability, never invent it: a language is a
 * **structural language** exactly when its profile carries a {@link structure}
 * section, and it contributes repo-map symbols exactly when it carries a
 * {@link repomap} section. What a profile does not claim, smelt does not do.
 */
export interface LanguageProfile {
  readonly id: LanguageId;
  /** File extensions (lowercase, no dot) that detect as this language. */
  readonly extensions: readonly string[];
  /** The bundled grammar file, e.g. `'tree-sitter-python.wasm'`. */
  readonly wasm: string;
  /**
   * The line-comment leader the marker lands behind (`'// '`, `'# '`), so the
   * survivor still parses in this language's own syntax. A bare `<<smelt…>>` line was
   * measured to break the reparse non-locally in every grammar tested — see the doc
   * on `MARKER_LINE_COMMENT_LEADERS` in `src/apply.ts` for the failure classes.
   * Absent only for a language whose survivors have no syntax to break.
   */
  readonly markerLeader?: string;
  /**
   * What the structural planner needs to parse this language honestly. Present iff
   * the language is claimed by `structural/v1`; the derived `STRUCTURAL_LANGUAGES`
   * list is exactly the profiles that carry this section.
   */
  readonly structure?: LanguageStructure;
  /** What the repo map's tag extraction reads. See {@link RepoMapFacts}. */
  readonly repomap?: RepoMapFacts;
}

/**
 * What the structural planner needs to know about a language, beyond its grammar:
 * which node types are comments (so a doc comment travels with its declaration),
 * which node types merely wrap the declaration that should be named
 * (`export function f()` is a function, `@cached def f()` is a function), and the
 * human word for each top-level node kind.
 */
export interface LanguageStructure {
  /** Top-level node types that are comments, in this grammar's vocabulary. */
  readonly commentTypes: ReadonlySet<string>;
  /**
   * Top-level node types that are outer attributes — parsed as siblings of the item
   * they decorate, but attached forward to it unconditionally by the planner's
   * `unitsOf`, because that is what the attribute means in the language.
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
   * a `#!` shebang line (javascript's `hash_bang_line`, kotlin and swift's
   * `shebang_line`). Each is its own uncollapsible unit: a run that swallowed one
   * would change what the survivor *is*, not just what it contains.
   */
  readonly pinnedTypes?: ReadonlySet<string>;
  /**
   * Per-node-type text patterns that pin a node the way {@link pinnedTypes} does —
   * for kinds where only *some* nodes govern the file. C and C++ parse every
   * `#pragma` as a `preproc_call`; only `#pragma once` changes what including the
   * survivor *means*, so only it is pinned.
   */
  readonly pinnedPatternsByType?: Readonly<Record<string, RegExp>>;
  /**
   * Node types that belong to the *preceding* statement despite being parsed as
   * top-level siblings — ruby's `heredoc_body`, which tree-sitter emits as a sibling
   * of the statement holding the heredoc opener. Such a node extends the previous
   * unit, so a collapse can never keep an opener while cutting its body (an
   * unterminated heredoc the reparse cannot even see — tree-sitter-ruby reports no
   * ERROR for a heredoc left open at EOF).
   */
  readonly ridesBackwardTypes?: ReadonlySet<string>;
  /**
   * Node types the grammar extends over trailing comments that belong to what
   * *follows* — kotlin's `import_list` swallows a KDoc that directly follows the
   * imports, which is the doc comment of the first declaration after them. The unit
   * for such a node ends at its last non-comment token; the trailing comments ride
   * forward and attach like any other comment block.
   */
  readonly trailingCommentSplitTypes?: ReadonlySet<string>;
  /**
   * Node types that wrap the declaration worth naming — the marker should say what is
   * inside, not name the wrapper. The value is the label to fall back to when nothing
   * nameable is found inside.
   */
  readonly wrapperTypes: Readonly<Record<string, string>>;
  /**
   * Human words per node type. What a language's map does not name, the planner
   * still labels honestly: an `ERROR` node is an `'unparsed region'`, any other
   * statement kind is a `'statement'`, and only what remains is called a
   * `'declaration'` — a marker that calls a parse error or a log line a declaration
   * would be lying about the tree.
   */
  readonly kindLabels: Readonly<Record<string, string>>;
}

/**
 * What the repo map's tag extraction (`repomap/tags.ts`) knows about a language.
 *
 * `defKinds` lists only node kinds whose `name` field is an *identifier* node,
 * because that is what the extraction walk reads — a kind whose name is spelled
 * differently (php's `name` nodes, ruby's `constant` class names, bash's `word`
 * function names, kotlin's field-less declarations) is *omitted*, not guessed at. An
 * omitted kind means fewer symbols on the map, never wrong ones.
 */
export interface RepoMapFacts {
  /** Declaration node type → human kind word. Absent from the map = not a definition. */
  readonly defKinds: Readonly<Record<string, string>>;
  /** Node types counted as references. */
  readonly refTypes: readonly string[];
}
