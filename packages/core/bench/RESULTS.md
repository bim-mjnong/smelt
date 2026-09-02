# smelt bench — results

Measured by `bench/run.mjs` on the committed corpus (`bench/corpus/`,
`bench/cases.json`). Every row states what was measured, on which date, at which
corpus commit, under which tier — and, for token and retrieval rows, on which model,
because those numbers are model-specific. Rows are **append-only**: a re-run, or a
run on a newer model, adds rows and never edits one — tokenizers shift between
model generations (HANDOFF Decision 8), and an edit would rewrite history.

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
