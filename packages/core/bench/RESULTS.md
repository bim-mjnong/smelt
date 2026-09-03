# smelt bench — results

Measured by `bench/run.mjs` on the committed corpus (`bench/corpus/`,
`bench/cases.json`). Every row states what was measured, on which date, at which
corpus commit, under which tier — and, for token and retrieval rows, on which model,
because those numbers are model-specific. Rows are **append-only**: a re-run, or a
run on a newer model, adds rows and never edits one — tokenizers shift between
model generations (`docs/ARCHITECTURE.md` § Decision 8), and an edit would rewrite history.

Units mean exactly what they say: `bytes` is UTF-8 bytes of the input and the
smelted output; `tokens` is Anthropic's `/v1/messages/count_tokens` for the text
as a single user message on the named model (tier 2); `elisions retrieved` is
distinct elisions the named model asked back via `smelt_retrieve` out of the
distinct elisions stored (tier 3), where retrieving everything is a LOSS. Nothing
here is extrapolated, rounded up, or converted between units.

## run 2026-09-01 — tier 1 — corpus c03abf27bd4a

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-01 | c03abf27bd4a  | —     | bytes | 14339 | 3264   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-01 | c03abf27bd4a  | —     | bytes | 1090  | 858    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| multi-file-grep | tier 1 | 2026-09-01 | c03abf27bd4a  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-01 | c03abf27bd4a  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-01 | c03abf27bd4a  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-01 — tier 1 — corpus 3613beb4b650

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-01 | 3613beb4b650  | —     | bytes | 22530 | 3289   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-01 | 3613beb4b650  | —     | bytes | 1090  | 858    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| multi-file-grep | tier 1 | 2026-09-01 | 3613beb4b650  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-01 | 3613beb4b650  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-01 | 3613beb4b650  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-01 — tier 1 — corpus 2a383919c632

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-01 | 2a383919c632  | —     | bytes | 30643 | 3289   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-01 | 2a383919c632  | —     | bytes | 1090  | 858    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-01 | 2a383919c632  | —     | bytes | 689   | 360    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-01 | 2a383919c632  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-01 | 2a383919c632  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-01 | 2a383919c632  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 052bd3be2ed7

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 052bd3be2ed7  | —     | bytes | 38267 | 3295   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 052bd3be2ed7  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 052bd3be2ed7  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 052bd3be2ed7  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 052bd3be2ed7  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 052bd3be2ed7  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 23cda4d958df

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 23cda4d958df  | —     | bytes | 38267 | 3295   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 23cda4d958df  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 23cda4d958df  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 23cda4d958df  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 23cda4d958df  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 23cda4d958df  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 031510948db6

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 031510948db6  | —     | bytes | 22432 | 3281   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 031510948db6  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 031510948db6  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 031510948db6  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 031510948db6  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 031510948db6  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 2675775cb1e3

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 2675775cb1e3  | —     | bytes | 22432 | 3281   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 2675775cb1e3  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 2675775cb1e3  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 2675775cb1e3  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 2675775cb1e3  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 2675775cb1e3  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 1f65ab089364

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 1f65ab089364  | —     | bytes | 22462 | 3680   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 1f65ab089364  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 1f65ab089364  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 1f65ab089364  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 1f65ab089364  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 1f65ab089364  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 916469e794aa

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 916469e794aa  | —     | bytes | 22462 | 3680   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 916469e794aa  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 916469e794aa  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 916469e794aa  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 916469e794aa  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 916469e794aa  | —     | bytes | 16354 | 109    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 6be404f0c24d

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 6be404f0c24d  | —     | bytes | 22462 | 3680   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 6be404f0c24d  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 6be404f0c24d  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 6be404f0c24d  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 6be404f0c24d  | —     | bytes | 452   | 344    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 6be404f0c24d  | —     | bytes | 16354 | 109    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-03 — tier 1 — corpus 8d700b307c09

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                       |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ------------------------------------------ |
| large-ts-file   | tier 1 | 2026-09-03 | 8d700b307c09  | —     | bytes | 27889 | 9632   | 3        | budget 4000 B, structural/v1 — OVER BUDGET |
| tsx-component   | tier 1 | 2026-09-03 | 8d700b307c09  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET  |
| java-classes    | tier 1 | 2026-09-03 | 8d700b307c09  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1                |
| multi-file-grep | tier 1 | 2026-09-03 | 8d700b307c09  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                  |
| stack-trace     | tier 1 | 2026-09-03 | 8d700b307c09  | —     | bytes | 452   | 344    | 1        | budget 400 B, lexical/v1                   |
| build-log       | tier 1 | 2026-09-03 | 8d700b307c09  | —     | bytes | 16354 | 109    | 1        | budget 800 B, lexical/v1                   |

## run 2026-09-03 — tier 1 — corpus 15b5543f5515

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                       |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ------------------------------------------ |
| large-ts-file   | tier 1 | 2026-09-03 | 15b5543f5515  | —     | bytes | 31229 | 10866  | 3        | budget 4000 B, structural/v1 — OVER BUDGET |
| tsx-component   | tier 1 | 2026-09-03 | 15b5543f5515  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET  |
| java-classes    | tier 1 | 2026-09-03 | 15b5543f5515  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1                |
| multi-file-grep | tier 1 | 2026-09-03 | 15b5543f5515  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                  |
| stack-trace     | tier 1 | 2026-09-03 | 15b5543f5515  | —     | bytes | 452   | 344    | 1        | budget 400 B, lexical/v1                   |
| build-log       | tier 1 | 2026-09-03 | 15b5543f5515  | —     | bytes | 16354 | 109    | 1        | budget 800 B, lexical/v1                   |

### Reading `large-ts-file` across the last three runs

Its `input` column moved 22462 → 27889 → 31229, and its `output` 3680 → 9632 → 10866.
None of that is the planner behaving differently. `large-ts-file`'s corpus file _is_
`packages/core/src/plan/structural.ts`, materialized from the working tree and
sha256-pinned — so every commit that edits the structural planner also edits the thing
being measured, and the corpus-commit column is where that shows. Comparing two of
these tables as a before/after of one input reads a change that did not happen.

What the last two runs did change: the structural planner grew a budget rung, and it
fires on none of these six cases. Planning each structural case twice — once at its
declared budget, once at a budget nothing can exceed — gives byte-identical plans, so
the two rows marked OVER BUDGET (large-ts-file 10866/4000, tsx-component 861/700) are
the maximal-run pass alone, over budget with no profitable sub-run left to take. The
rung's own case is a 158-byte fixture in `test/structural.test.ts`; this corpus does not
exercise it, and a case that does is worth adding.
