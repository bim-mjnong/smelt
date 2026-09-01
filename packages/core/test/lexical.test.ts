import { describe, expect, it } from 'vitest';

import { LEXICAL_PLANNER_ID, planLexical } from '../src/plan/lexical.ts';

const lines = (count: number, prefix = 'noise'): string =>
  Array.from({ length: count }, (_, i) => `${prefix} ${String(i)} ....................`).join('\n');

describe('the lexical planner', () => {
  it('keeps the focus match and a window of context around it', () => {
    const text = `${lines(80)}\nthe NEEDLE is here\n${lines(80, 'after')}`;
    const plan = planLexical({ text, language: 'unknown', budgetBytes: 600, focus: ['needle'] });

    expect(plan.planner).toBe(LEXICAL_PLANNER_ID);
    expect(plan.elisions.length).toBe(2);

    const kept = applied(text, plan.elisions);
    expect(kept).toContain('the NEEDLE is here');
    expect(kept).toContain('noise 79');
    expect(kept).toContain('after 0');
    expect(kept).not.toContain('noise 10');
  });

  it('is case-insensitive by default and exact when asked', () => {
    const text = `${lines(60)}\nSHOUTING match\n${lines(60, 'tail')}`;
    expect(
      planLexical({ text, language: 'unknown', budgetBytes: 500, focus: ['shouting'] }).elisions
        .length,
    ).toBe(2);
    expect(
      planLexical(
        { text, language: 'unknown', budgetBytes: 500, focus: ['shouting'] },
        { caseSensitive: true },
      ).elisions.length,
    ).toBe(1);
  });

  it('falls back to head and tail when there is nothing to focus on', () => {
    const text = lines(400);
    const plan = planLexical({ text, language: 'unknown', budgetBytes: 2_000 });
    expect(plan.elisions.length).toBe(1);
    expect(plan.elisions[0]!.reason.rule).toBe('head-tail');
    expect(plan.elisions[0]!.reason.explanation).toMatch(/^collapsed \d+ lines from the middle$/);

    const kept = applied(text, plan.elisions);
    expect(kept).toContain('noise 0 ');
    expect(kept).toContain('noise 399');
  });

  it('squeezes harder when the budget is tight, and gives up honestly rather than cutting the match', () => {
    const text = `${lines(400)}\nthe NEEDLE is here\n${lines(400, 'after')}`;
    const generous = planLexical({
      text,
      language: 'unknown',
      budgetBytes: 100_000,
      focus: ['needle'],
    });
    const tight = planLexical({ text, language: 'unknown', budgetBytes: 200, focus: ['needle'] });

    expect(removed(tight.elisions)).toBeGreaterThan(removed(generous.elisions));
    // 200 bytes is not achievable without dropping the match. It keeps the match.
    expect(applied(text, tight.elisions)).toContain('the NEEDLE is here');
  });

  it('leaves short runs alone — a marker costs more than the lines it replaces', () => {
    const text = ['keep NEEDLE', 'a', 'b', 'keep NEEDLE too'].join('\n');
    const plan = planLexical({
      text,
      language: 'unknown',
      budgetBytes: 10,
      focus: ['needle'],
    });
    expect(plan.elisions).toEqual([]);
  });

  it('is deterministic', () => {
    const text = `${lines(200)}\nNEEDLE\n${lines(200, 'z')}`;
    const input = { text, language: 'unknown' as const, budgetBytes: 900, focus: ['needle'] };
    expect(JSON.stringify(planLexical(input))).toBe(JSON.stringify(planLexical(input)));
  });

  it('handles an empty input without inventing an elision', () => {
    expect(planLexical({ text: '', language: 'unknown', budgetBytes: 10 }).elisions).toEqual([]);
  });

  it('ignores empty focus terms rather than matching everything', () => {
    const text = lines(300);
    const withEmpty = planLexical({
      text,
      language: 'unknown',
      budgetBytes: 2_000,
      focus: ['', ''],
    });
    expect(withEmpty.elisions[0]!.reason.rule).toBe('head-tail');
  });
});

function applied(text: string, elisions: readonly { range: { start: number; end: number } }[]) {
  const buffer = Buffer.from(text, 'utf8');
  const pieces: Buffer[] = [];
  let cursor = 0;
  for (const { range } of elisions) {
    pieces.push(buffer.subarray(cursor, range.start));
    cursor = range.end;
  }
  pieces.push(buffer.subarray(cursor));
  return Buffer.concat(pieces).toString('utf8');
}

function removed(elisions: readonly { range: { start: number; end: number } }[]) {
  return elisions.reduce((sum, e) => sum + (e.range.end - e.range.start), 0);
}
