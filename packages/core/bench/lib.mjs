/**
 * Pure helpers for the measurement harness — no I/O, no network, no imports beyond
 * nothing at all. Everything here is a function from values to values, so
 * `test/bench.test.ts` can exercise the harness's logic without a built `dist` and
 * without a key.
 *
 * The tier semantics these helpers encode are HANDOFF Decision 8:
 *
 *   tier 1 — bytes and elision counts. Deterministic, offline, no key.
 *   tier 2 — token counts via Anthropic's `/v1/messages/count_tokens`. Free, needs a
 *            key, and every row names the model, because token counts are
 *            model-specific — a count without its model named is not a measurement.
 *   tier 3 — expansion rate from real model calls, counting `smelt_retrieve`
 *            invocations. Paid; run once, retrieval log committed.
 *
 * Law 4 discipline is enforced structurally: a row cannot be rendered without a
 * date, a corpus commit, and a tier, and a token row cannot be rendered without a
 * model. There is no bytes→tokens conversion anywhere in this harness, at any
 * tier — a byte count multiplied by a fudge factor is an invented number.
 */

export const RESULTS_HEADER = [
  'case',
  'tier',
  'date',
  'corpus commit',
  'model',
  'unit',
  'input',
  'output',
  'elisions',
  'note',
];

/** Phrases Law 4 forbids in a results file: extrapolation dressed as measurement. */
export const FORBIDDEN_RESULT_PHRASES = ['up to', 'cache hit rate'];

/**
 * Validates the parsed `cases.json`. `fileExists` is injected so this stays pure.
 * Returns the list of problems — an empty array is a pass.
 */
export function validateCases(manifest, fileExists) {
  const problems = [];
  if (manifest?.format !== 'smelt-bench-cases/v1') {
    problems.push(`unknown cases format: ${String(manifest?.format)}`);
    return problems;
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    problems.push('no cases declared');
    return problems;
  }
  const seen = new Set();
  for (const benchCase of manifest.cases) {
    const id = String(benchCase.id ?? '<missing id>');
    if (seen.has(id)) problems.push(`duplicate case id: ${id}`);
    seen.add(id);
    if (typeof benchCase.file !== 'string' || !fileExists(benchCase.file)) {
      problems.push(`${id}: corpus file missing: ${String(benchCase.file)}`);
    }
    if (typeof benchCase.path !== 'string' || benchCase.path.length === 0) {
      problems.push(`${id}: no declared path`);
    }
    if (!Array.isArray(benchCase.focus) || benchCase.focus.length === 0) {
      problems.push(`${id}: no focus terms — a case without a task is not realistic`);
    }
    if (!Number.isInteger(benchCase.budgetBytes) || benchCase.budgetBytes <= 0) {
      problems.push(`${id}: budgetBytes must be a positive integer`);
    }
    if (benchCase.strategy !== 'lexical' && benchCase.strategy !== 'structural') {
      problems.push(`${id}: strategy must be 'lexical' or 'structural'`);
    }
    if (typeof benchCase.provenance !== 'string' || benchCase.provenance.length === 0) {
      problems.push(`${id}: no provenance — a corpus entry must say where it came from`);
    }
  }
  return problems;
}

/**
 * One rendered results row. Every field is required except `model`, which is
 * required exactly when the unit is not bytes — see the throw below.
 */
export function resultRow({
  caseId,
  tier,
  date,
  corpusCommit,
  model,
  unit,
  input,
  output,
  elisions,
  note,
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new Error(`resultRow: date must be YYYY-MM-DD, got ${String(date)}`);
  }
  if (!/^[0-9a-f]{7,40}$/.test(String(corpusCommit))) {
    throw new Error(`resultRow: corpusCommit must be a git hash, got ${String(corpusCommit)}`);
  }
  if (tier !== 1 && tier !== 2 && tier !== 3) {
    throw new Error(`resultRow: tier must be 1, 2 or 3, got ${String(tier)}`);
  }
  if (unit !== 'bytes' && (typeof model !== 'string' || model.length === 0)) {
    throw new Error(
      `resultRow: a ${String(unit)} row must name its model — token counts are ` +
        'model-specific, and a count without the model named is not a measurement',
    );
  }
  return [
    caseId,
    `tier ${String(tier)}`,
    date,
    corpusCommit,
    unit === 'bytes' ? '—' : model,
    unit,
    String(input),
    String(output),
    elisions === undefined ? '—' : String(elisions),
    note ?? '',
  ];
}

/** Renders header + rows as a markdown table. */
export function renderTable(rows) {
  const all = [RESULTS_HEADER, RESULTS_HEADER.map(() => '---'), ...rows];
  return all.map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

/**
 * Appends a section to an existing results document, refusing to touch what is
 * already there. Rows are append-only: a re-run on a newer model is a new row,
 * never an edit — tokenizers shift between model generations (HANDOFF Decision 8),
 * and editing a row would silently rewrite history.
 */
export function appendResults(existing, section) {
  const base = existing.trimEnd();
  const combined = `${base}\n\n${section.trimEnd()}\n`;
  if (!combined.startsWith(base)) {
    throw new Error('appendResults: refusing to modify existing rows');
  }
  for (const phrase of FORBIDDEN_RESULT_PHRASES) {
    if (section.toLowerCase().includes(phrase)) {
      throw new Error(`appendResults: "${phrase}" is not a measurement — Law 4 refuses it`);
    }
  }
  return combined;
}

/**
 * The `/v1/messages/count_tokens` request body for one blob of text. The count is
 * of the text as a single user message on the named model — that is what tier 2
 * reports, stated as such. No conversion, no adjustment.
 */
export function countTokensRequest(model, text) {
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('countTokensRequest: model is required');
  }
  return {
    model,
    messages: [{ role: 'user', content: text }],
  };
}

/**
 * Tier 3's verdict for one case, from its retrieval log. A case where the model
 * retrieved every elision back is a LOSS, reported as such with its input: every
 * byte smelt hid cost a round trip and saved nothing (HANDOFF Decision 4 names
 * this the one degenerate outcome).
 */
export function tier3Verdict({ elisionsStored, uniqueRetrieved }) {
  if (uniqueRetrieved > elisionsStored) {
    throw new Error(
      'tier3Verdict: retrieved more distinct hashes than were stored — the log is corrupt',
    );
  }
  const expansionRate = elisionsStored === 0 ? 0 : uniqueRetrieved / elisionsStored;
  return {
    expansionRate,
    loss: elisionsStored > 0 && uniqueRetrieved === elisionsStored,
  };
}

/** Aggregate expansion rate over all tier-3 cases: total retrieved / total stored. */
export function tier3Aggregate(verdictInputs) {
  const stored = verdictInputs.reduce((sum, entry) => sum + entry.elisionsStored, 0);
  const retrieved = verdictInputs.reduce((sum, entry) => sum + entry.uniqueRetrieved, 0);
  return stored === 0 ? 0 : retrieved / stored;
}

/**
 * The note cell for one tier-3 row. A truncated run — the round cap hit while the
 * model was still calling tools — is stated as such and outranks a LOSS verdict:
 * its retrieval count is a floor from a cut-off conversation, so both the
 * flattering reading ("sub-1.0 rate") and the damning one ("LOSS") would be
 * unmeasured claims about a run that never finished (Law 4).
 */
export function tier3RowNote({ verdict, retrieveCalls, truncated, maxRounds }) {
  const base = `expansion rate ${verdict.expansionRate.toFixed(2)}, ${String(retrieveCalls)} calls`;
  if (truncated) {
    return (
      `${base} — TRUNCATED: the ${String(maxRounds)}-round cap was hit mid-task; ` +
      'the rate is a floor from a cut-off run, not a completed measurement'
    );
  }
  return verdict.loss ? `${base} — LOSS: the model retrieved everything back` : base;
}

/**
 * The format marker a by-reference corpus entry carries. Such an entry is a committed
 * `<name>.json` beside the corpus instead of committed bytes: it names a working-tree
 * source file and pins its sha256. The runner materializes the real file at run time
 * and refuses a hash mismatch — see {@link corpusRefMismatch}. This replaces the old
 * byte-copy discipline for corpus files that mirror this repository's own source: the
 * pinned hash, not a second copy of the bytes, is what keeps provenance honest.
 */
export const CORPUS_REF_FORMAT = 'smelt-bench-corpus-ref/v1';

/**
 * The refusal for a by-reference corpus entry whose source drifted from its pinned
 * hash. Refusing IS the provenance discipline: a source that moved since the hash was
 * pinned must never be silently measured under the old reference, because the corpus
 * commit in every RESULTS.md row has to name the exact bytes measured (Law 4).
 */
export function corpusRefMismatch({ refFile, from, pinned, actual }) {
  return (
    `corpus reference ${refFile} pins sha256 ${pinned}, but ${from} in the working ` +
    `tree hashes to ${actual}. The source has moved since the hash was pinned — ` +
    `REFUSING to materialize or measure it. Review the change, update the pinned ` +
    `sha256 in ${refFile}, and commit it, so the corpus commit in every RESULTS.md ` +
    `row names the exact bytes it measured.`
  );
}
