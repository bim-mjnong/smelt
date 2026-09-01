import { Parser } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';

import { describe, expect, it, vi } from 'vitest';

import { applyPlan } from '@guard/apply';
import { GrammarUnavailableError } from '@guard/errors';
import { createSmelter } from '@guard/index';
import { loadGrammar } from '@guard/plan/grammar';
import { planStructural, STRUCTURAL_PLANNER_ID } from '@guard/plan/structural';
import { MemoryElisionStore } from '@guard/store';
import type { ElisionPlan, PlanInput } from '@guard/types';

import {
  BOUNDARY_TS,
  BUILD_TAG_GO,
  FIXTURE_BY_LANGUAGE,
  FUNCTIONS_PY,
  FUNCTIONS_RB,
  FUNCTIONS_RS,
  FUNCTIONS_SH,
  FUNCTIONS_TS,
  LONG_DOC_COMMENT,
  LONG_DOC_TS,
  MIXED_TSX,
} from '../structural-fixtures.ts';

/**
 * STRUCTURAL-PLANNER GUARD — the guarantees Slice 2 claims.
 *
 * Six properties, each of which could quietly rot into something that still *looks*
 * structural from the outside:
 *
 *  1. **The explanation names kind and count from the parse tree** — `collapsed 3
 *     sibling functions`, never a line count as the claim. Lose this and Law 2
 *     degrades into the `[...truncated...]` it exists to replace.
 *  2. **The labels are honest for text that is not clean code.** A labeled_statement
 *     is a statement and an ERROR node is an unparsed region — never a
 *     "declaration", which would tell the model broken text was code that parsed.
 *  3. **A kept declaration keeps its signature line and attached doc comment,
 *     always.** The fixture's doc comment is forty lines long, because the cheap bug
 *     is an attachment heuristic that silently hands a big comment to the collapse.
 *  4. **Ranges never cross a parse-node boundary.** Every elision endpoint must be a
 *     top-level node boundary of the real parse — a range that cuts into a
 *     declaration produces output that lies about the code's structure. (Node
 *     boundaries are character boundaries, so this also covers multi-byte safety,
 *     which the reversibility guard asserts separately.)
 *  5. **No silent fallback, on either path.** A language this planner has not mapped
 *     *and* a mapped language whose grammar fails to load are both exceptions —
 *     never lexical output labelled `structural/v1`, which would be undetectable
 *     from the outside.
 *  6. **An elision never costs more than it removes.** The profitability check
 *     renders the actual marker, because a mixed-kind explanation can outgrow a
 *     small cut — and an optimizer that grows its input is worse than none.
 *
 * Plus the determinism claim: same file, same focus, byte-identical plan — asserted
 * by running it, not assumed. Mutations for all of these live in `scripts/mutate.mjs`;
 * `pnpm mutate` proves each one turns this file red.
 */

function inputFor(text: string, focus: readonly string[], language: PlanInput['language']) {
  return { text, language, budgetBytes: 600, focus } as const;
}

async function structuralPlan(
  text: string,
  focus: readonly string[],
  language: PlanInput['language'] = 'typescript',
): Promise<ElisionPlan> {
  return planStructural(inputFor(text, focus, language));
}

describe('Slice 2 — the structural planner keeps its claims', () => {
  it('explains every elision with a kind and a count, never a line count', async () => {
    const plans = [
      await structuralPlan(FUNCTIONS_TS, ['handleRequest']),
      await structuralPlan(LONG_DOC_TS, ['retryWithBackoff']),
      await structuralPlan(BOUNDARY_TS, ['greetTarget']),
    ];
    const elisions = plans.flatMap((plan) => plan.elisions);
    expect(elisions.length, 'no elisions planned — this guard would be vacuous').toBeGreaterThan(2);
    for (const { reason } of elisions) {
      expect(reason.rule).toBe('sibling-collapse');
      // The kind-and-count shape, from the parse tree: "collapsed 2 sibling
      // functions", or the mixed form "collapsed 4 sibling declarations (…)".
      expect(reason.explanation).toMatch(/^collapsed \d+ sibling [a-z]/);
      // Never a line count as the primary claim — that is the lexical planner's
      // vocabulary, and structural output claiming it has lost its reason to exist.
      expect(reason.explanation).not.toMatch(/\d+ lines?\b/);
    }
  });

  it('keeps a kept declaration whole: signature line and forty-line doc comment', async () => {
    // Self-check first, so the fixture cannot quietly stop being the hard case.
    expect(LONG_DOC_COMMENT.split('\n')).toHaveLength(40);
    expect(LONG_DOC_TS).toContain(LONG_DOC_COMMENT);

    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(LONG_DOC_TS, {
      language: 'typescript',
      budgetBytes: 600,
      focus: ['retryWithBackoff'],
    });
    expect(
      result.elisions.length,
      'nothing elided — the assertion below is vacuous',
    ).toBeGreaterThan(0);
    // The signature line survives…
    expect(result.text).toContain('export async function retryWithBackoff<T>(');
    // …and so does the attached doc comment, every byte of it.
    expect(result.text).toContain(LONG_DOC_COMMENT);
    expect(smelter.reconstruct(result)).toBe(LONG_DOC_TS);
  });

  it('never lets a range cross a top-level parse-node boundary', async () => {
    for (const [text, focus, language] of [
      [FUNCTIONS_TS, ['handleRequest'], 'typescript'],
      [BOUNDARY_TS, ['greetTarget'], 'typescript'],
      [MIXED_TSX, ['Toolbar'], 'tsx'],
    ] as const) {
      const plan = await structuralPlan(text, focus, language);
      expect(plan.elisions.length, 'no elisions — boundary check is vacuous').toBeGreaterThan(0);

      // An independent parse, and an independent code-unit → byte conversion: the
      // boundaries come from the tree itself, not from the planner under test.
      const grammar = await loadGrammar(language);
      const parser = new Parser();
      parser.setLanguage(grammar);
      const tree = parser.parse(text);
      expect(tree).not.toBeNull();
      const toBytes = (index: number): number => Buffer.byteLength(text.slice(0, index), 'utf8');
      const starts = new Set<number>();
      const ends = new Set<number>();
      for (const child of tree!.rootNode.namedChildren) {
        if (child === null) continue;
        starts.add(toBytes(child.startIndex));
        ends.add(toBytes(child.endIndex));
      }
      tree!.delete();
      parser.delete();

      for (const { range } of plan.elisions) {
        expect(starts, `range start ${String(range.start)} is not a node start`).toContain(
          range.start,
        );
        expect(ends, `range end ${String(range.end)} is not a node end`).toContain(range.end);
      }
    }
  });

  it('throws GrammarUnavailableError instead of falling back to lexical', async () => {
    await expect(structuralPlan(FUNCTIONS_TS, ['handleRequest'], 'unknown')).rejects.toThrow(
      GrammarUnavailableError,
    );
    const smelter = createSmelter({ strategy: 'structural' });
    await expect(
      smelter.smelt('just some prose, no language at all', { budgetBytes: 100 }),
    ).rejects.toThrow(GrammarUnavailableError);
  });

  it('rejects when the grammar for a supported language cannot load — never lexical output', async () => {
    // The other half of "no silent fallback": the language is mapped, but the grammar
    // itself will not load — a corrupted or missing wasm in the field. The failure must
    // surface as the loader's own error, never as line-window output labelled
    // structural/v1, which is undetectable from the outside. Slice 4 extended the
    // check to a new language: the rule holds per grammar, not just for the two the
    // planner started with.
    vi.resetModules();
    vi.doMock('@guard/plan/grammar', () => ({
      loadGrammar: () =>
        Promise.reject(
          new GrammarUnavailableError('smelt: induced grammar-load failure, for this guard'),
        ),
    }));
    try {
      const fresh =
        (await import('@guard/plan/structural')) as typeof import('@guard/plan/structural');
      await expect(
        fresh.planStructural(inputFor(FUNCTIONS_TS, ['handleRequest'], 'typescript')),
      ).rejects.toThrow(GrammarUnavailableError);
      await expect(
        fresh.planStructural(inputFor(FUNCTIONS_RS, ['resolve_target'], 'rust')),
      ).rejects.toThrow(GrammarUnavailableError);
    } finally {
      vi.doUnmock('@guard/plan/grammar');
      vi.resetModules();
    }
  });

  it('labels statements and unparsed regions honestly, never as declarations', async () => {
    // Log lines parsed as TypeScript are labeled_statement nodes; garbage is ERROR and
    // empty_statement nodes. A marker that calls either a "declaration" tells the model
    // the text was code that parsed — the parse tree says otherwise, and Law 2 says the
    // explanation reads off the tree.
    const log = Array.from({ length: 6 }, (_, i) => `line ${String(i)}: routine chatter here`).join(
      '\n',
    );
    const logPlan = await structuralPlan(log, []);
    expect(logPlan.elisions.length, 'log input planned nothing — vacuous').toBeGreaterThan(0);
    for (const { reason } of logPlan.elisions) {
      expect(reason.explanation).toMatch(/sibling statements$/);
      expect(reason.explanation).not.toContain('declaration');
    }

    const garbage = Array.from({ length: 5 }, () => '%%%% not typescript at all ???!!! ;;; @@@')
      .join('\n')
      .concat('\n');
    const garbagePlan = await structuralPlan(garbage, []);
    expect(garbagePlan.elisions.length, 'garbage input planned nothing — vacuous').toBeGreaterThan(
      0,
    );
    for (const { reason } of garbagePlan.elisions) {
      expect(reason.explanation).not.toContain('declaration');
      expect(reason.explanation).toContain('unparsed region');
    }
  });

  it('never plans an elision whose marker costs more bytes than it removes', async () => {
    // Eight tiny declarations of many kinds: the run is real, but the mixed-kind
    // explanation makes the marker bigger than the cut. The honest move is to plan
    // nothing — an optimizer that grows its input is worse than none.
    const tiny = [
      'type Alias = 1;',
      'enum Level {}',
      'interface Cfg { x: 1 }',
      'class Box {}',
      'const nine = 1;',
      'declare const flag: 1;',
      'function noop() {}',
      'let extra = 2;',
    ].join('\n');
    const plan = await structuralPlan(tiny, []);
    const result = applyPlan(tiny, plan, new MemoryElisionStore());
    expect(
      result.outputBytes,
      'the output grew: a marker cost more than the bytes it removed',
    ).toBeLessThanOrEqual(result.inputBytes);
  });

  it('labels every plan it does produce as its own', async () => {
    const plan = await structuralPlan(FUNCTIONS_TS, ['handleRequest']);
    expect(plan.planner).toBe(STRUCTURAL_PLANNER_ID);
    expect(plan.language).toBe('typescript');
  });

  it('is deterministic: repeated runs produce byte-identical plans and output', async () => {
    const runs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const plan = await structuralPlan(FUNCTIONS_TS, ['handleRequest']);
      const result = applyPlan(FUNCTIONS_TS, plan, new MemoryElisionStore());
      runs.push(JSON.stringify({ plan, text: result.text }));
    }
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });
});

/**
 * SLICE 4 AND 4B — the same claims, thirteen more languages.
 *
 * Every language in `FIXTURE_BY_LANGUAGE` is planned by the same machinery as
 * TypeScript and TSX: the marker names kind and count from the parse tree, a kept
 * declaration keeps its signature and its doc comment in the language's own idiom
 * (`///`, javadoc, PHPDoc, KDoc, a docstring, `#`), and grammar failure is an
 * exception, never lexical output. One claim is survivor-shaped: **for python, ruby
 * and bash, the survivor still parses.** Python's significant indentation means a
 * parse error does not stay local; ruby and bash read the marker's own `<<` as a
 * heredoc operator, so a bare marker line would swallow every kept declaration after
 * it into a string. The marker therefore lands as a `#` comment in all three (see
 * `markerForLanguage`), and this guard *reparses the post-applyPlan survivor* and
 * asserts it introduces no ERROR or missing nodes that the original parse did not
 * have. Mutations for each of these live in `scripts/mutate.mjs`.
 */
/** Every ERROR or missing node in an independent parse of `text`. */
async function parseIssues(
  text: string,
  language: PlanInput['language'],
): Promise<readonly string[]> {
  const grammar = await loadGrammar(language as Exclude<PlanInput['language'], 'unknown'>);
  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(text);
  expect(tree).not.toBeNull();
  const issues: string[] = [];
  const walk = (node: Node): void => {
    if (node.type === 'ERROR' || node.isMissing) {
      issues.push(`${node.type}@${String(node.startIndex)}`);
    }
    for (const child of node.children) {
      if (child !== null) walk(child);
    }
  };
  walk(tree!.rootNode);
  tree!.delete();
  parser.delete();
  return issues;
}

describe('Slices 4 and 4b — every claimed language keeps the same claims', () => {
  const CASES = Object.entries(FIXTURE_BY_LANGUAGE).map(([language, fixture]) => ({
    language: language as PlanInput['language'],
    ...fixture,
  }));

  it('explains with kind and count in every language, including each pure same-kind form', async () => {
    for (const { language, text, focus, pureCollapse } of CASES) {
      const plan = await structuralPlan(text, focus, language);
      expect(
        plan.elisions.length,
        `${language}: no elisions planned — this guard would be vacuous`,
      ).toBeGreaterThan(0);
      for (const { reason } of plan.elisions) {
        expect(reason.rule).toBe('sibling-collapse');
        expect(reason.explanation).toMatch(/^collapsed \d+ sibling [a-z]/);
        expect(reason.explanation).not.toMatch(/\d+ lines?\b/);
      }
      // The same shape TypeScript earns — kind and count read off this language's own
      // parse tree, in its strongest guaranteed form ("collapsed 2 sibling functions",
      // "… classes", "… methods" — the mixed form only where the fixture mixes kinds).
      expect(
        plan.elisions.some(({ reason }) => pureCollapse.test(reason.explanation)),
        `${language}: expected ${String(pureCollapse)} among: ` +
          plan.elisions.map((e) => e.reason.explanation).join(' | '),
      ).toBe(true);
    }
  });

  it('names language-specific kinds honestly in mixed collapses', async () => {
    const rust = await structuralPlan(FUNCTIONS_RS, ['resolve_target'], 'rust');
    expect(
      rust.elisions.some(({ reason }) =>
        /^collapsed \d+ sibling declarations \(1 struct, 1 impl block\)$/.test(reason.explanation),
      ),
      `rust: ${rust.elisions.map((e) => e.reason.explanation).join(' | ')}`,
    ).toBe(true);

    const go = await structuralPlan(
      FIXTURE_BY_LANGUAGE.go.text,
      FIXTURE_BY_LANGUAGE.go.focus,
      'go',
    );
    const goMixed = go.elisions.map((e) => e.reason.explanation).join(' | ');
    expect(goMixed, `go: ${goMixed}`).toContain('1 method');
    expect(goMixed).toContain('1 type declaration');
    expect(goMixed).toContain('1 package clause');

    const python = await structuralPlan(FUNCTIONS_PY, ['fetch_user'], 'python');
    const pyMixed = python.elisions.map((e) => e.reason.explanation).join(' | ');
    expect(pyMixed, `python: ${pyMixed}`).toContain('1 class');
    expect(pyMixed).toContain('1 import statement');

    // A sample across the 4b languages: the kind words come from each parse tree.
    const java = await structuralPlan(
      FIXTURE_BY_LANGUAGE.java.text,
      FIXTURE_BY_LANGUAGE.java.focus,
      'java',
    );
    const javaMixed = java.elisions.map((e) => e.reason.explanation).join(' | ');
    expect(javaMixed, `java: ${javaMixed}`).toContain('1 package declaration');
    expect(javaMixed).toContain('1 import declaration');

    const c = await structuralPlan(FIXTURE_BY_LANGUAGE.c.text, FIXTURE_BY_LANGUAGE.c.focus, 'c');
    const cMixed = c.elisions.map((e) => e.reason.explanation).join(' | ');
    expect(cMixed, `c: ${cMixed}`).toContain('include directive');
    expect(cMixed).toContain('1 macro definition');

    const bash = await structuralPlan(
      FIXTURE_BY_LANGUAGE.bash.text,
      FIXTURE_BY_LANGUAGE.bash.focus,
      'bash',
    );
    const bashMixed = bash.elisions.map((e) => e.reason.explanation).join(' | ');
    expect(bashMixed, `bash: ${bashMixed}`).toContain('1 command');
  });

  it('keeps the focused declaration whole — signature and doc comment — and round-trips', async () => {
    for (const { language, text, focus, signature, doc } of CASES) {
      const smelter = createSmelter({ strategy: 'structural' });
      const result = await smelter.smelt(text, { language, budgetBytes: 600, focus });
      expect(
        result.elisions.length,
        `${language}: nothing elided — the assertions below are vacuous`,
      ).toBeGreaterThan(0);
      expect(result.text, `${language}: the signature line did not survive`).toContain(signature);
      expect(result.text, `${language}: the doc comment did not survive`).toContain(doc);
      expect(smelter.reconstruct(result), `${language}: reconstruction drifted`).toBe(text);
    }
  });

  for (const [language, text, focus] of [
    ['python', FUNCTIONS_PY, ['fetch_user']],
    ['ruby', FUNCTIONS_RB, ['handle_request']],
    ['bash', FUNCTIONS_SH, ['handle_request']],
  ] as const) {
    it(`the ${language} survivor still parses: the reparse introduces no ERROR nodes`, async () => {
      // Self-check: the fixture parses cleanly, so "no new ERROR nodes" below means
      // exactly "no ERROR nodes at all" — the comparison cannot be vacuous.
      expect(await parseIssues(text, language), 'the fixture itself must parse cleanly').toEqual(
        [],
      );

      const smelter = createSmelter({ strategy: 'structural' });
      const result = await smelter.smelt(text, { language, budgetBytes: 600, focus });
      expect(
        result.elisions.length,
        'nothing elided — the reparse below is vacuous',
      ).toBeGreaterThan(0);
      expect(
        await parseIssues(result.text, language),
        `the survivor no longer parses as ${language} — an elision broke the structure of what remains`,
      ).toEqual([]);
      // How that is achieved: every marker landed as a comment in the survivor's own
      // syntax. In python a bare marker breaks the block structure; in ruby and bash
      // the marker's own `<<` would open a heredoc and swallow what follows.
      for (const { marker } of result.elisions) {
        expect(
          marker.startsWith('# <<smelt/'),
          `marker is not a ${language} comment: ${marker}`,
        ).toBe(true);
      }
      expect(smelter.reconstruct(result)).toBe(text);
    });
  }

  it('bare applyPlan defaults its marker to the plan language — python still parses', async () => {
    // The documented public composition is `planStructural → applyPlan`, with no
    // options. If that path defaulted to the bare `<<smelt/v1…>>` marker, a python
    // survivor would stop parsing — exactly the failure the comment leader prevents —
    // and only the createSmelter path would keep the claim.
    const plan = await structuralPlan(FUNCTIONS_PY, ['fetch_user'], 'python');
    const result = applyPlan(FUNCTIONS_PY, plan, new MemoryElisionStore());
    expect(result.elisions.length, 'nothing elided — the reparse is vacuous').toBeGreaterThan(0);
    expect(await parseIssues(result.text, 'python')).toEqual([]);
  });

  it('refuses a python collapse whose marker would comment out kept code on its line', async () => {
    // tree-sitter-python emits semicolon-separated top-level statements as separate
    // module children, the second starting mid-line. A `# `-led marker replacing the
    // first would comment out the rest of the line — the exact statement the caller
    // asked to keep, syntactically alive as a comment and semantically dead. The
    // planner must refuse that collapse.
    const text =
      'configure_everything_up_front("a deliberately long argument string, padded until ' +
      'the collapse would clearly pay for its marker", 12345); TARGET_FLAG = True\n';
    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(text, {
      language: 'python',
      budgetBytes: 10,
      focus: ['TARGET_FLAG'],
    });
    // The kept statement is still real code: its line is not a comment…
    const flagLine = result.text.split('\n').find((line) => line.includes('TARGET_FLAG = True'));
    expect(flagLine, 'the kept statement vanished entirely').toBeDefined();
    expect(
      flagLine!.trimStart().startsWith('#'),
      `the kept statement was swallowed into a comment: ${flagLine!}`,
    ).toBe(false);
    // …and the survivor still parses as python.
    expect(await parseIssues(result.text, 'python')).toEqual([]);
    expect(smelter.reconstruct(result)).toBe(text);
  });

  it('pins a go build-tag comment to the file — it never collapses into a run', async () => {
    // `//go:build` must be followed by a blank line (the Go spec requires it), so it
    // can never attach to a declaration — and a collapse that swallows it silently
    // changes which builds see the file. The planner pins it instead.
    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(BUILD_TAG_GO, {
      language: 'go',
      budgetBytes: 10,
      focus: ['Target'],
    });
    expect(
      result.elisions.length,
      'nothing elided — the build-tag assertion below is vacuous',
    ).toBeGreaterThan(0);
    expect(result.text, 'the build constraint did not survive').toContain('//go:build linux');
    expect(smelter.reconstruct(result)).toBe(BUILD_TAG_GO);
  });

  it('pins file-governing prefixes in the 4b languages: shebangs, magic comments, `<?php`', async () => {
    // Same law as the go build tag: a run that swallows one of these changes what the
    // survivor *is* — which interpreter runs it, whether its strings are frozen,
    // whether the file is php at all — with no elision the caller asked for.
    const PINS = [
      { language: 'javascript', pinned: '#!/usr/bin/env node' },
      { language: 'ruby', pinned: '#!/usr/bin/env ruby' },
      { language: 'ruby', pinned: '# frozen_string_literal: true' },
      { language: 'php', pinned: '<?php' },
      { language: 'bash', pinned: '#!/usr/bin/env bash' },
    ] as const;
    for (const { language, pinned } of PINS) {
      const fixture = FIXTURE_BY_LANGUAGE[language];
      const smelter = createSmelter({ strategy: 'structural' });
      const result = await smelter.smelt(fixture.text, {
        language,
        budgetBytes: 10,
        focus: fixture.focus,
      });
      expect(
        result.elisions.length,
        `${language}: nothing elided — the pin assertion below is vacuous`,
      ).toBeGreaterThan(0);
      expect(
        result.text,
        `${language}: the pinned prefix ${JSON.stringify(pinned)} did not survive`,
      ).toContain(pinned);
      expect(smelter.reconstruct(result)).toBe(fixture.text);
    }
  });
});
