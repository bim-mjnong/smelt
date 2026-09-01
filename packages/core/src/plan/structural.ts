import { NotImplementedError } from '../errors.ts';
import type { ElisionPlan, PlanInput, Planner } from '../types.ts';

export const STRUCTURAL_PLANNER_ID = 'structural/v1';

export interface StructuralPlannerOptions {
  /** Always keep the signature line of an enclosing declaration. */
  readonly keepSignatures?: boolean;
  /** Always keep the doc comment attached to a kept declaration. */
  readonly keepDocComments?: boolean;
  /** Never collapse a sibling group smaller than this. */
  readonly minSiblings?: number;
}

/**
 * **Not implemented.** This is the planner smelt is actually for; see
 * `docs/HANDOFF.md` § "Slice 2".
 *
 * The intended behaviour: parse with the language's tree-sitter grammar, find the
 * nodes that match the caller's focus, keep each match's enclosing declaration —
 * signature, doc comment, and body — and collapse its *siblings* into one marker that
 * names them ("collapsed 3 sibling functions"). Structure is what makes the
 * explanation possible; a line window can only ever say "collapsed 40 lines".
 *
 * It throws rather than falling back to {@link LexicalPlanner}, and that is the
 * deliberate part. A silent fallback would mean a caller who asked for structural
 * planning, and whose grammar failed to load, gets line-window output labelled
 * `structural/v1` — plausible, wrong, and undetectable from the outside. Ask for
 * something that does not exist and you get an exception, not an approximation.
 */
export class StructuralPlanner implements Planner {
  readonly id = STRUCTURAL_PLANNER_ID;
  readonly options: StructuralPlannerOptions;

  constructor(options: StructuralPlannerOptions = {}) {
    this.options = options;
  }

  plan(_input: PlanInput): Promise<ElisionPlan> {
    throw new NotImplementedError('the structural planner', 'docs/HANDOFF.md § "Slice 2"');
  }
}
