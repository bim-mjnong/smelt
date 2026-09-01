import { OverlappingElisionError, RangeOutOfBoundsError } from './errors.ts';
import type {
  AppliedElision,
  ByteRange,
  DetectedLanguage,
  ElisionPlan,
  ElisionStore,
  Measure,
  SmeltResult,
} from './types.ts';

/** Everything the marker text is allowed to depend on. */
export interface MarkerInfo {
  readonly hash: string;
  readonly bytes: number;
  readonly rule: string;
  readonly explanation: string;
}

export type MarkerBuilder = (info: MarkerInfo) => string;

/**
 * The version of the marker format itself, carried **in band** in every marker.
 *
 * The marker is the one part of smelt a *model* sees, and it goes into prompts.
 * Changing its shape changes model behaviour downstream and shows up as worse output
 * with no error anywhere — this project's signature failure mode, shipped as a patch
 * release. So the wire surface is frozen from 0.1 and treated as 1.0
 * (`CONTRIBUTING.md` § "Two promises, not one"), and a future format is *additive and
 * identifiable*: `smelt/v2` markers can coexist with `smelt/v1` ones, and a consumer
 * parsing markers can tell which it is holding. A format that changed silently would
 * be a substitution; this makes it a declaration.
 *
 * `test/guards/marker-format.test.ts` pins the rendered marker per version and fails if
 * the format moves without the version moving.
 */
export const MARKER_FORMAT_VERSION = 'v1';

/**
 * The default marker.
 *
 * Its shape is the user-facing form of Laws 2 and 3, in one line the model reads:
 * *which format this is* (the version), *what was removed* (the explanation), *how
 * much* (the byte count), and *how to get it back* (the hash). Anything that cannot
 * fill in all of those is not allowed to be an elision.
 *
 * `<<…>>` rather than a Unicode bracket because it survives every tokenizer, terminal,
 * and diff tool without becoming three tokens of nothing.
 */
export const defaultMarker: MarkerBuilder = ({ explanation, bytes, hash }) =>
  `<<smelt/${MARKER_FORMAT_VERSION}: ${explanation} (${String(bytes)}B) — retrieve("${hash}")>>`;

/**
 * Line-comment leaders for languages where a bare marker line breaks the syntax of
 * what remains around it.
 *
 * Python is the one entry, and it earns its place: significant indentation means a
 * parse error does not stay local. Reparsing a survivor whose marker sits bare between
 * two `def`s shows the ERROR node swallowing the *neighbouring definitions too* — the
 * survivor stops being Python at all, not just at the marker line. Brace-delimited
 * languages keep their structure around an unparsable line, so they keep the bare
 * marker.
 *
 * This does **not** move the frozen wire surface. The `<<smelt/v1: … >>` core is
 * rendered by {@link defaultMarker}, byte-identical and still versioned in band; the
 * leader is part of the substituted marker text, so `outputRange` covers it and
 * reconstruction stays byte-exact. A comment leader in the survivor's own syntax is
 * the one wrapping that cannot change what a model reads out of the marker.
 */
export const MARKER_LINE_COMMENT_LEADERS: Readonly<Partial<Record<DetectedLanguage, string>>> = {
  python: '# ',
};

/**
 * The marker builder for a language: {@link defaultMarker}, wrapped in the language's
 * line-comment leader when {@link MARKER_LINE_COMMENT_LEADERS} names one — so a Python
 * survivor still parses as Python. Everything else gets `base` unchanged.
 */
export function markerForLanguage(
  language: DetectedLanguage,
  base: MarkerBuilder = defaultMarker,
): MarkerBuilder {
  const leader = MARKER_LINE_COMMENT_LEADERS[language];
  if (leader === undefined) return base;
  return (info) => `${leader}${base(info)}`;
}

export interface ApplyOptions {
  /**
   * Overrides the marker builder. The default follows the *plan's* language —
   * {@link markerForLanguage} — so the documented composition
   * `planStructural → applyPlan` lands a `# `-led marker in python without the caller
   * wiring it, the same as `createSmelter` does. A bare {@link defaultMarker} in a
   * python survivor is exactly the parse-breaking failure the leader exists to prevent.
   */
  readonly marker?: MarkerBuilder;
  /** A consumer-supplied counter. See {@link Measure}; the budget stays in bytes. */
  readonly measure?: Measure;
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
  const buildMarker = options.marker ?? markerForLanguage(plan.language);
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

  const output = Buffer.concat(pieces).toString('utf8');
  const measure = options.measure;

  return {
    text: output,
    inputBytes: input.length,
    outputBytes,
    planner: plan.planner,
    language: plan.language,
    elisions: applied,
    ...(measure === undefined
      ? {}
      : {
          measured: {
            measure: measure.id,
            unit: measure.unit,
            input: measure.count(text),
            output: measure.count(output),
          },
        }),
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
