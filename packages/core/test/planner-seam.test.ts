import { describe, expect, it } from 'vitest';

import { createSmelter } from '../src/index.ts';
import type { ElisionPlan, PlanInput, Planner } from '../src/types.ts';

/**
 * The Planner seam, proven from the outside: `createSmelter({ planner })` runs the
 * whole pipeline — plan, apply, store, marker, retrieve, reconstruct — with a planner
 * this file wrote, no grammar and no registry anywhere in sight. This is the leverage
 * the seam buys: everything downstream of planning is testable (and extensible)
 * without tree-sitter.
 */

const original = [
  'keep this first line',
  'ELIDE ME: the middle line',
  'keep this last line',
  '',
].join('\n');

/** Byte range of the middle line, including its trailing newline. */
function middleLineRange(): { start: number; end: number } {
  const start = Buffer.byteLength('keep this first line\n', 'utf8');
  const end = start + Buffer.byteLength('ELIDE ME: the middle line\n', 'utf8');
  return { start, end };
}

function fakePlanner(): Planner & { readonly seen: PlanInput[] } {
  const seen: PlanInput[] = [];
  return {
    id: 'fake/v1',
    seen,
    plan(input: PlanInput): Promise<ElisionPlan> {
      seen.push(input);
      return Promise.resolve({
        planner: 'fake/v1',
        language: input.language,
        elisions: [
          {
            range: middleLineRange(),
            reason: { rule: 'fake-middle', explanation: 'elided the middle line' },
          },
        ],
      });
    },
  };
}

describe('createSmelter({ planner }) — an injected planner drives smelt() end to end', () => {
  it('plans, applies, stores and reverses without any grammar', async () => {
    const planner = fakePlanner();
    const smelter = createSmelter({ planner });

    const result = await smelter.smelt(original, { budgetBytes: 50, focus: ['keep'] });

    // The plan came from the fake, and the fake saw the real inputs.
    expect(result.planner).toBe('fake/v1');
    expect(planner.seen).toHaveLength(1);
    expect(planner.seen[0]?.budgetBytes).toBe(50);
    expect(planner.seen[0]?.focus).toEqual(['keep']);

    // The cut really happened, with a marker in place of the middle line.
    expect(result.text).not.toContain('ELIDE ME');
    expect(result.text).toContain('<<smelt/v1:');
    expect(result.text).toContain('elided the middle line');
    expect(result.elisions).toHaveLength(1);

    // The elided bytes are retrievable and the round trip closes, byte for byte.
    const hash = result.elisions[0]!.hash;
    expect(smelter.retrieve(hash)).toBe('ELIDE ME: the middle line\n');
    expect(smelter.reconstruct(result)).toBe(original);
    expect(smelter.stats().elisionsStored).toBe(1);
  });

  it('wins over strategy: a constructed instance is more specific than a name', async () => {
    // 'structural' on a .kt path would need a bundled grammar; the fake needs nothing.
    // The planner id in the result proves which one ran.
    const smelter = createSmelter({ planner: fakePlanner(), strategy: 'structural' });
    const result = await smelter.smelt(original, { budgetBytes: 50, path: 'App.kt' });
    expect(result.planner).toBe('fake/v1');
    expect(result.language).toBe('kotlin');
  });
});
