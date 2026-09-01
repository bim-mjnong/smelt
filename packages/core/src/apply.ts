import { OverlappingElisionError, RangeOutOfBoundsError } from './errors.ts';
import type { AppliedElision, ByteRange, ElisionPlan, ElisionStore, SmeltResult } from './types.ts';

/** Everything the marker text is allowed to depend on. */
export interface MarkerInfo {
  readonly hash: string;
  readonly bytes: number;
  readonly rule: string;
  readonly explanation: string;
}

export type MarkerBuilder = (info: MarkerInfo) => string;

/**
 * The default marker.
 *
 * Its shape is the user-facing form of Laws 2 and 3, in one line the model reads:
 * *what was removed* (the explanation), *how much* (the byte count), and *how to get it
 * back* (the hash). Anything that cannot fill in all three is not allowed to be an
 * elision.
 *
 * `<<…>>` rather than a Unicode bracket because it survives every tokenizer, terminal,
 * and diff tool without becoming three tokens of nothing.
 */
export const defaultMarker: MarkerBuilder = ({ explanation, bytes, hash }) =>
  `<<smelt: ${explanation} (${bytes}B) — retrieve("${hash}")>>`;

export interface ApplyOptions {
  readonly marker?: MarkerBuilder;
}

/**
 * Turn a plan into text.
 *
 * This is the only function in smelt that removes anything, and it contains no
 * judgement at all: it validates the plan, stores every removed run, substitutes
 * markers, and records where each marker landed. All the deciding happens in a
 * {@link Planner}, which is why a plan can be reviewed before a byte moves.
 *
 * @throws {RangeOutOfBoundsError} if a range falls outside the input's UTF-8 bytes.
 * @throws {OverlappingElisionError} if two ranges overlap — applying both would
 *   corrupt the output, and picking a winner would be a silent guess.
 */
export function applyPlan(
  text: string,
  plan: ElisionPlan,
  store: ElisionStore,
  options: ApplyOptions = {},
): SmeltResult {
  const buildMarker = options.marker ?? defaultMarker;
  const input = Buffer.from(text, 'utf8');

  const ordered = plan.elisions.toSorted((a, b) => a.range.start - b.range.start);
  for (const { range } of ordered) assertInBounds(range, input.length);
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (current.range.start < previous.range.end) {
      throw new OverlappingElisionError(
        `smelt: plan from "${plan.planner}" elides overlapping ranges ` +
          `[${previous.range.start},${previous.range.end}) and ` +
          `[${current.range.start},${current.range.end}). A plan must be a partition.`,
      );
    }
  }

  const pieces: Buffer[] = [];
  const applied: AppliedElision[] = [];
  let cursor = 0;
  let outputBytes = 0;

  for (const { range, reason } of ordered) {
    const kept = input.subarray(cursor, range.start);
    pieces.push(kept);
    outputBytes += kept.length;

    const removed = input.subarray(range.start, range.end);
    const removedText = removed.toString('utf8');
    const hash = store.put(removedText);
    const marker = buildMarker({
      hash,
      bytes: removed.length,
      rule: reason.rule,
      explanation: reason.explanation,
    });
    const markerBuffer = Buffer.from(marker, 'utf8');
    pieces.push(markerBuffer);

    applied.push({
      hash,
      range,
      outputRange: { start: outputBytes, end: outputBytes + markerBuffer.length },
      bytes: removed.length,
      reason,
      marker,
    });
    outputBytes += markerBuffer.length;
    cursor = range.end;
  }

  const tail = input.subarray(cursor);
  pieces.push(tail);
  outputBytes += tail.length;

  return {
    text: Buffer.concat(pieces).toString('utf8'),
    inputBytes: input.length,
    outputBytes,
    planner: plan.planner,
    language: plan.language,
    elisions: applied,
  };
}

/**
 * Put it all back. `reconstruct(smelt(x), store) === x`, byte for byte — this is Law 3
 * expressed as an executable equation, and `test/guards/reversibility.test.ts` asserts
 * it on every input the suite knows about.
 *
 * @throws {UnknownHashError} if the store no longer holds an elision's bytes.
 */
export function reconstruct(result: SmeltResult, store: ElisionStore): string {
  const output = Buffer.from(result.text, 'utf8');
  const ordered = result.elisions.toSorted((a, b) => a.outputRange.start - b.outputRange.start);
  const pieces: Buffer[] = [];
  let cursor = 0;

  for (const elision of ordered) {
    assertInBounds(elision.outputRange, output.length);
    pieces.push(output.subarray(cursor, elision.outputRange.start));
    pieces.push(Buffer.from(store.retrieve(elision.hash), 'utf8'));
    cursor = elision.outputRange.end;
  }
  pieces.push(output.subarray(cursor));

  return Buffer.concat(pieces).toString('utf8');
}

function assertInBounds(range: ByteRange, length: number): void {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end > length ||
    range.start >= range.end
  ) {
    throw new RangeOutOfBoundsError(
      `smelt: range [${range.start},${range.end}) is not a non-empty range inside ` +
        `${String(length)} bytes.`,
    );
  }
}
