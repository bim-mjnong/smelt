<div align="center">
<img src="../assets/smelt-mark.svg" width="88" alt="" />
</div>

# smelt — handoff

**Audience:** a competent engineer who has never seen this project. Read this before the
code. It says what smelt is, why each of its four laws exists, exactly what is scaffolded
versus what is yours to build, and the order to build it in.

**Status:** the spine is real and green, and every v1 slice has shipped: the CLI
(Slice 1, plus `smelt init` and `smelt.config.json`), the structural planner for
fifteen languages (Slices 2, 4 and 4b), the measurement harness (Slice 3 — tiers 1
and 2 runnable, tier 3 built but deliberately not run), the persistent store
(Slice 5), cache-prefix hygiene (Slice 6) and the repo map (Slice 7).
Nothing has been published to npm; publishing is a founder action. The eight
questions this document used to end with are answered, in "Decisions the founder has
made" below.

---

## What smelt is

smelt is a Node/TypeScript library that shrinks what a coding agent sends to a model,
without lying about what it removed. Given a blob of text — a file, a grep result, a
stack trace, a diff — and a byte budget, it returns a smaller blob in which the parts the
task needs survive and everything else has been replaced by a one-line marker that says
what went, how big it was, and a hash to get it back. The removed bytes are stored
locally, and the model is given a `smelt_retrieve` tool. Every retrieval is counted, so
over-pruning shows up as a number instead of as a model that is quietly wrong. It makes
no network calls, and a test fails if it could. It is a **library**, not a proxy: it
transforms content its caller hands it and never intercepts anyone's traffic.

---

## The four laws, and why each one is load-bearing

These are not preferences. Each one exists because breaking it produces a library that
_looks_ like it works, and a contributor acting in good faith will break them helpfully
unless they understand why they are there.

### Law 1 — zero network

**v1 makes no external calls. Code never leaves the machine.** Scoring is structural
(tree-sitter WASM) and lexical. Reranking exists as a _pluggable stage interface_ that a
consumer wires its own key into — never a default, never bundled.

_Why it is load-bearing:_ the natural way to make a context optimizer better is to ask a
model which parts matter. The moment that becomes a default, every consumer of smelt is
shipping their users' source code to a third party — and they find out from a changelog,
or a proxy log, or not at all. There is no way to opt out of a default you did not know
existed. The zero-network property is also the only reason smelt is usable inside
companies that will never approve an outbound call from a dev tool, which is a large
fraction of the people who need it most.

The subtle failure is not someone adding `fetch()` on purpose. It is a grammar cache:
`web-tree-sitter`'s `Language.load()` accepts `string | URL`, and "download the grammar
on first use" is a perfectly reasonable-looking optimisation that works flawlessly on the
machine that wrote it. That is why `src/plan/grammar.ts` reads the `.wasm` bytes itself
and hands tree-sitter a `Uint8Array` — removing the capability rather than documenting it
— and why `assertLocalResource()` rejects any non-`file:` scheme before that.

Enforced by `test/guards/no-network.test.ts`, which walks the real import graph and
classifies _every_ edge. See "How to prove a guard can fail" below.

### Law 2 — every elision is explainable

**Every removal can state what it removed, in words, from a named rule.** "collapsed 3
sibling functions, retrievable" — never a model's opinion, never "compressed by 62%".

_Why it is load-bearing:_ explainability is what makes the output debuggable and the
library trustworthy at the same time. When an agent gets an answer wrong, the first
question is "what did it not see?", and a marker that says `collapsed 3 sibling
functions` answers it while `[...truncated...]` does not. It also disciplines the
implementation: a rule you cannot describe in a sentence is a rule you do not understand,
and it will do something surprising. This is why `ElisionReason` has two fields — a
stable `rule` id for counters and an `explanation` a human reads — and why every planner
must fill in both.

The consequence people find surprising: **no learned distillation in v1.** A model-written
summary cannot satisfy this law. "The model condensed this" does not say what was
removed, and once the text has been rewritten there is nothing left to store under a
hash. The interface exists (`DistillStage`); the implementation does not.

### Law 3 — every elision is reversible

**What is elided is stored locally, keyed by content hash; the model gets a stub plus a
`retrieve(hash)` tool. Expansions are counted.**

_Why it is load-bearing:_ reversibility is what makes cutting safe enough to do
aggressively. But reversibility alone is trivially gameable — a library that hides 90% of
every file is "reversible" and useless — so the second sentence carries as much weight as
the first. **The expansion rate is the honest signal of over-pruning.** If the model keeps
calling `smelt_retrieve`, smelt cut material the task needed, and each round trip cost
more tokens than the elision saved. A retrieve counter that is not wired up leaves that
rate pinned at a flattering zero forever, which is precisely the shape of failure this
project exists to refuse — hence `test/guards/expansion-counter.test.ts` guarding an
increment.

Two design consequences worth understanding before you change them:

- `AppliedElision.outputRange` records where the marker landed in the _output_. Without
  it, "reversible" would mean parsing markers back out of text, which is a guess.
  Reversibility is a fact recorded at the moment of the cut.
- `MemoryElisionStore` has no eviction and no `clear()`. A store that can forget turns
  this law into "reversible, usually", and a `retrieve()` that fails after an eviction is
  indistinguishable to the model from a hallucinated hash.

### Law 4 — claim no number that has not been measured

**Absolute.** Not in the README, not in a doc comment, not in a commit message, not in a
tweet.

_Why it is load-bearing:_ this is the entire differentiator. The pitch smelt came from
claimed "80–94% token reduction" and a "90%+ cache hit rate". Both are unsupported: the
second conflates Anthropic's 0.1× _price_ for a cached read with a _hit rate_, which are
unrelated quantities, and no benchmark producing either figure exists. Publishing them
would have been the first thing a knowledgeable reader checked and the last thing they
believed.

What is honest to say instead: state the **mechanism** and the **class** of expected
saving _with its source_. The nearest real comparable is Headroom's own stated **15–20%
for coding agents** (its 60–95% figures apply to narrow content like JSON logs).
LLMLingua's 20× results are on non-code benchmarks. Until smelt has run its own harness
on its own traffic, the README states mechanisms and cites other people's numbers as
other people's. Slice 3 below is the harness that changes that.

---

## What is scaffolded, file by file

Everything below exists, is typechecked, linted, and covered. `pnpm verify` is green.

### Real implementations

| File                                | What it does                                                                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/types.ts`        | The vocabulary: `Planner`, `ElisionPlan`, `AppliedElision`, `ElisionStore`, `RetrieveStats`, `Measure`, `RerankStage`, `DistillStage`. Read this first — the doc comments carry the reasoning. |
| `packages/core/src/errors.ts`       | Every error is a `SmeltError`, so callers can tell "the library said no" from "something broke".                                                                                               |
| `packages/core/src/hash.ts`         | 16 hex chars of sha256. Short because the hash goes in every marker and the model pays for it.                                                                                                 |
| `packages/core/src/detect.ts`       | Extension → language. `'unknown'` is a first-class answer, not a failure.                                                                                                                      |
| `packages/core/src/store.ts`        | `MemoryElisionStore`: content-addressed, dedupes, refuses hash collisions, counts retrievals.                                                                                                  |
| `packages/core/src/retrieve.ts`     | `createRetrieveTool()` — the `smelt_retrieve` tool a consumer hands its model. Not MCP- or SDK-specific on purpose.                                                                            |
| `packages/core/src/apply.ts`        | `applyPlan()` (the only function that removes anything), `reconstruct()` (Law 3 as an equation), and `MARKER_FORMAT_VERSION` — the wire surface, frozen. No judgement at all.                  |
| `packages/core/src/plan/lexical.ts` | The lexical planner: focus-window and head-tail rules, a context ladder under budget pressure, profitability check so a marker never costs more than the lines it replaces. Deterministic.     |
| `packages/core/src/plan/grammar.ts` | Loads a prebuilt grammar `.wasm` off disk, through `assertLocalResource`. Bundled copy first, `tree-sitter-wasms` as the source-checkout fallback. Cached.                                     |
| `packages/core/src/net/policy.ts`   | Law 1, written once: forbidden transports, forbidden globals, **and** the permitted sets — so the guard is a partition, not an allowlist.                                                      |
| `packages/core/src/cli/args.ts`     | `node:util.parseArgs`, zero new dependencies. `--budget` is required; its absence is a usage error, and so are `0`, `-1` and `4kb`. Also the help text.                                        |
| `packages/core/src/cli/report.ts`   | The stderr report. Every total is read off the `SmeltResult`: two pieces of code counting the same bytes is how a report ends up disagreeing with its own library.                             |
| `packages/core/src/cli/run.ts`      | The CLI as a function returning an exit code, so it runs in-process in tests. The `--json` envelope and the `--reconstruct` round trip live here.                                              |
| `packages/core/src/cli/bin.ts`      | The `smelt` binary. Owns only what cannot be tested without a real process: the shebang, stdin on fd 0, the exit code.                                                                         |
| `packages/core/src/index.ts`        | `createSmelter()` and the public surface.                                                                                                                                                      |

### Stubs that throw (by design — read `CONTRIBUTING.md` § "A stub throws")

| File                          | Why it throws                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/stages.ts` | `unconfiguredRerankStage` and `unconfiguredDistillStage`. Both name the interface you were meant to implement. Out of v1 — see below. |

`packages/core/src/plan/structural.ts` is no longer a stub: **Slice 2 shipped it**, for
TypeScript and TSX, **Slice 4 extended it** to Rust, Python and Go, and **Slice 4b
extended it again** to JavaScript, Java, C, C++, C#, Ruby, PHP, Kotlin, Swift and
Bash. It still refuses
rather than falling back — an unmapped language or
a failed grammar load throws `GrammarUnavailableError`, because output labelled
`structural/v1` that is really line windows is undetectable from outside.

### The honesty machinery

| File                                                    | What it guards                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/test/guards/no-network.test.ts`          | Law 1. Walks the import graph from **every entrypoint the manifest advertises** (`exports` + `bin`, so the CLI is in the walk); classifies every edge; closes the vacuous-walk, unwalked-file, unvetted-dependency and unwalked-entrypoint holes.                                                                                                            |
| `packages/core/test/guards/reversibility.test.ts`       | Law 3. `reconstruct(smelt(x)) === x` over multi-byte, CRLF, no-trailing-newline and one-20 kB-line inputs, plus every refusal.                                                                                                                                                                                                                               |
| `packages/core/test/guards/expansion-counter.test.ts`   | The retrieve counter and `allElisionsRetrieved`, i.e. the observability half of Law 3.                                                                                                                                                                                                                                                                       |
| `packages/core/test/guards/marker-format.test.ts`       | The wire surface. The rendered marker is pinned per version: the format cannot change without the version changing, and an unknown version fails.                                                                                                                                                                                                            |
| `packages/core/test/guards/third-party.test.ts`         | Attribution. Reruns the real generator and fails if the committed `THIRD-PARTY.md` differs; also proves the generator refuses an unattributed grammar.                                                                                                                                                                                                       |
| `packages/core/test/guards/persistent-store.test.ts`    | Law 3 across a process boundary. A damaged blob is refused as `StoreCorruptionError`, never returned; the retrieval counters survive a restart; "we hold damaged bytes" stays distinct from "never existed".                                                                                                                                                 |
| `packages/core/test/guards/cache-hygiene.test.ts`       | Slice 6's promise: cache-prefix hygiene detects and warns, never rewrites — inputs stay unmutated, no export returns a "fixed" prompt, and no cache-hit-rate figure exists anywhere in `src`.                                                                                                                                                                |
| `packages/core/test/guards/structural.test.ts`          | The structural planner's claims: honest kinds and counts in every marker, no silent lexical fallback, doc comments attached, pins respected, and a survivor that still parses in its own grammar.                                                                                                                                                            |
| `packages/core/test/guards/structural-totality.test.ts` | Tests for every claimed language: each id in `STRUCTURAL_LANGUAGES` must have a fixture, a committed snapshot and a doc-comment case — claiming a language without tests goes red.                                                                                                                                                                           |
| `packages/core/test/guards/bench-results.test.ts`       | The harness's honesty: `RESULTS.md` rows carry date + corpus commit + tier (and model where required), stay append-only, never say "up to"; network shapes confined to `tier2.mjs`/`tier3.mjs`; `bench/` never enters the published `files` list.                                                                                                            |
| `packages/core/test/guards/repo-map.test.ts`            | Slice 7's claims: the byte budget respected by construction, deterministic ranked output, content-hash cache invalidation, and corrupt cache entries discarded loudly rather than trusted.                                                                                                                                                                   |
| `packages/core/test/guards/init-wizard.test.ts`         | `smelt init`'s one hard rule: an existing file is never overwritten without an explicit per-file yes.                                                                                                                                                                                                                                                        |
| `packages/core/test/guards/planner-registry.test.ts`    | The strategy seam. The `PLANNERS` registry carries exactly the shipped strategies, and the factory, `--strategy`/config validation and the help text all serve its keys — a dropped entry goes red on every face at once.                                                                                                                                    |
| `packages/core/test/guards/_source.ts`                  | Shared source-walking helpers: `guardSrcRoot()`, `guardRoot()`, and the string/comment stripper that stops `net/policy.ts` reporting its own word list.                                                                                                                                                                                                      |
| `scripts/mutate.mjs`                                    | **The meta-guard, as a thin runner.** Discovers the guard files and applies each one's own `MUTATIONS` export — 64 mutations across 13 guards, each of which must go red. A survivor is reported as a hole in the guard, not the mutation; the counts in this row are verified, not typed — the runner fails when they drift from what the guard files hold. |
| `scripts/bundle-grammars.mjs`                           | Copies the grammars `WASM_BY_LANGUAGE` names into the package, so they ship. Reads the built map rather than keeping a second list.                                                                                                                                                                                                                          |
| `scripts/generate-third-party.mjs`                      | Generates `THIRD-PARTY.md`. The grammar ↔ provenance mapping is a partition: an unattributed grammar throws.                                                                                                                                                                                                                                                 |
| `scripts/check-fresh-clone.sh`                          | Installs and verifies from `git archive` output — tracked files only.                                                                                                                                                                                                                                                                                        |
| `.github/workflows/ci.yml`                              | `pnpm verify` on Node 20.19/22.12/24, plus the fresh-clone job.                                                                                                                                                                                                                                                                                              |

### Not yet real

- No expansion-rate number, and no token-saving claim. The benchmark harness
  (**Slice 3**) is built and its tier-1 byte rows are committed in
  `packages/core/bench/RESULTS.md`, but tier 3 — the paid, model-calling tier that
  measures the expansion rate — has deliberately not been run; the founder runs it
  once and commits its log. Until then the only numbers smelt owns are tier-1
  bytes and elision counts.
- Cross-file reasoning inside `smelt()` itself. The repo map (**Slice 7**, shipped)
  covers the whole-tree shape as its own surface, but `smelt()` still sees one
  blob at a time.

---

## v1, sliced

Each slice is independently shippable and independently useful. Do them in order; the
ordering is not arbitrary — Slice 1 is how you _see_ Slice 2, and Slice 3 is what lets
you claim anything about Slice 2.

### Slice 1 — the demo surface: `smelt` CLI + a report — **SHIPPED**

The smallest thing that makes the library visible.

**Shipped as** a `bin` on `@smeltjs/core` (Decision 2), on `node:util.parseArgs`, with no
new dependencies:

```sh
smelt src/server.ts --budget 4000 --focus handleRequest
smelt --budget 4000 --focus TypeError < build.log
```

Prints the smelted text to stdout, and a report to stderr so the two can be piped apart:

A real run of the built binary, on this repository's own `plan/lexical.ts` — `--version`,
a smelt with its report, the marker it produced, the round trip closing byte for byte, and
the non-zero exit when the plan came back over budget:

![the smelt CLI running on packages/core/src/plan/lexical.ts](images/slice-1-cli.png)

The same run, as text:

```
smelt  packages/core/src/plan/lexical.ts  typescript  lexical/v1
in 7,297 B → out 985 B   (-86.5%, 3 elisions)

  rule          lines  bytes  hash              explanation
  focus-window     53  2,224  84998967370f38bc  collapsed 53 lines with no match for the focu…
  focus-window      4    253  cb63542ad561a25d  collapsed 4 lines with no match for the focus…
  focus-window    128  4,155  786640c78c602123  collapsed 128 lines with no match for the foc…
```

**Acceptance criteria**

- [x] `smelt <file>` and stdin both work; `--budget` is required and its absence is an error, not a default.
- [x] `--json` emits the `SmeltResult` verbatim, so it can be diffed in tests. It is nested in a versioned envelope alongside the elided bytes, because a result without its store is not reconstructible; `test/cli.test.ts` asserts the nested result equals the library's own, field for field.
- [x] The report totals equal `inputBytes`/`outputBytes` from the result — no separate accounting.
- [x] `--reconstruct` reads a `--json` result back and prints the original, proving the round trip from the command line. It verifies every hash against the bytes it keys and the reconstructed length against the recorded `inputBytes`, so an almost-right round trip fails.
- [x] Exit code is non-zero when the plan came back over budget, and says so. Never silently over budget. Codes are distinct: 1 over budget, 2 usage, 3 refused, 4 unexpected.
- [x] A screenshot of the built binary running on a real file: [`docs/images/slice-1-cli.png`](images/slice-1-cli.png). `node packages/core/dist/cli/bin.js` — the built artifact, not the dev server and not test output.

**Not in Slice 1, deliberately:** the CLI has no way to pass a `Measure`. A CLI flag
cannot name a function, and a plugin loader would be a dependency and an eval surface.
The report prints a measured line when the _library_ was given one.

### Slice 2 — the structural planner, TypeScript and TSX only — **SHIPPED**

The reason smelt exists. Scope it to two grammars; the machinery generalises in Slice 4.

**Build:** in `src/plan/structural.ts`, replace the throw. Parse with the language's
grammar; find nodes matching `focus`; for each match, keep its enclosing declaration —
signature, doc comment, body — and collapse its _siblings_ into one marker naming them.

**Acceptance criteria**

- [x] `collapsed 3 sibling functions` — the explanation names the _kind_ and the _count_, from the parse tree, not a line count.
- [x] A kept declaration keeps its signature line and attached doc comment, always. A fixture asserts this on a file where the doc comment is 40 lines long.
- [x] Ranges never split a multi-byte character and never cross a node boundary. The reversibility guard already covers the first; add a fixture for the second.
- [x] Grammar load failure throws `GrammarUnavailableError`. It does **not** fall back to lexical. A caller who wants the fallback asks for it.
- [x] Deterministic: same file, same focus, byte-identical plan. Asserted, not assumed.
- [x] A snapshot test per fixture, so a plan change shows up as a reviewable diff.
- [x] `pnpm mutate` gains a mutation for whatever new guarantee this slice claims.

### Slice 3 — the measurement harness — **SHIPPED** (tier 3 built, not yet run)

The slice that lets smelt say a number. Until this exists, Law 4 forbids all of them.

**Shipped as** `packages/core/bench/` — outside `src/`, so the zero-network guard's
walk is untouched, and outside `files`, so it ships in no tarball. A committed corpus
of real tool outputs (`bench/corpus/`, provenance per file in `bench/README.md`), a
runner (`pnpm bench`, node + built dist, zero dependencies), and an append-only
`bench/RESULTS.md`. Network access exists only in `tier2.mjs`/`tier3.mjs`, loaded
dynamically on their tiers; tier 1 is offline by construction, and
`test/guards/bench-results.test.ts` plus three mutations keep it that way. Tier 3 is
implemented but has not been run — it is the paid tier, the founder runs it once and
commits `bench/tier3-log/` — so no expansion-rate number exists yet, and none is
claimed.

**Build:** `packages/core/bench/` — a corpus of real tool outputs (files, greps, stack
traces, `cargo build` output), a set of realistic tasks with known answers, and a runner
that reports, per case: input bytes, output bytes, elisions, and — critically —
**expansion rate**, by actually asking a model and counting its `smelt_retrieve` calls.

**Tiers** — decided (Decision 8), now built. `count_tokens` is free, which is what makes
this affordable: Tier 1 is bytes and elision counts, deterministic, no key, reproducible
by any contributor offline. Tier 2 adds token counts through `count_tokens` — free, needs
any key. Tier 3 is expansion rate, the only paid part: run it once and commit the
retrieval log as an artifact so the rate is checkable from a committed file. Every row
names its model, and re-running on a newer model is a **new row, not an edit** — Claude's
tokenizer changed by ~30% between generations, and an edit would silently rewrite history.

**Acceptance criteria**

- [x] The corpus is committed, or fetched from a pinned public commit. Reproducible by a stranger. Committed under `bench/corpus/`; the runner refuses to run against uncommitted corpus changes, so every row's corpus commit is real.
- [x] Reports bytes _and_ tokens, per the tiers above. Never a byte count converted to tokens with a fudge factor. Tokens come only from `count_tokens` (tier 2, key-gated) and every token row names its model; no conversion exists anywhere in the harness, and the guard's row check plus `resultRow()`'s own throw enforce it.
- [ ] Reports expansion rate per case, and the aggregate. A case where the model retrieved everything back is reported as a **loss**, with its input. _Implemented (tier 3, `bench/tier3.mjs`: real model calls, the store's own counters, per-case retrieval log, LOSS verdict), but deliberately not run — it is the paid tier; the founder runs it once and commits `bench/tier3-log/` per Decision 8. Unticked until that run exists._
- [x] Output is a committed markdown table with the date, the corpus commit, and the model used. A number without those three is not a measurement. `bench/RESULTS.md`, append-only, guarded.
- [x] The README's numbers section is written from this table or stays empty. No rounding up, no "up to". It stays empty until the founder decides otherwise; the guard forbids "up to" in the results file itself.
- [x] The harness has no network access on the smelt side. Model calls are the harness's, made explicitly, outside the library. `src/` cannot reach `bench/`; the guard confines network shapes to `tier2.mjs`/`tier3.mjs` and a mutation proves it goes red.

### Slice 4 — structural planning for Rust, Python and Go — **SHIPPED**

Same machinery, three more node-kind sets.

**Shipped as** three more entries in the structural planner's language table
(`STRUCTURE_BY_LANGUAGE` in `src/plan/structural.ts`): each language names its comment
node types, its wrapper types (`export …`, `@decorator`), and a human word per top-level
node kind. The grammars were already bundled and load through the same
`assertLocalResource` + `readFile` path — no new dependency, no new transport.

The Python-specific decision: **the survivor must still parse.** Reparsing a survivor
whose marker sits bare between two `def`s shows the ERROR node swallowing the
neighbouring definitions — significant indentation means a parse error does not stay
local. So for Python the marker lands wrapped in the language's line-comment leader
(`# <<smelt/v1: … >>`, `markerForLanguage` in `src/apply.ts`). This does not move the
frozen wire surface: the `<<smelt/v1: … >>` core is byte-identical and still versioned
in band, and the leader is part of the substituted marker text, so `outputRange` covers
it and reconstruction stays byte-exact. (This slice originally let brace-delimited
languages keep the bare marker, on the claim that braces keep a parse error local; the
slice-4b review measured that claim and found it false in every grammar — see 4b below.
Every structural language now lands its marker behind its own line-comment leader.)

Three follow-up decisions, found in review and each guarded by a mutation:

- **Rust outer attributes ride forward.** tree-sitter-rust parses `#[…]` as a
  top-level _sibling_ of the item it decorates, so a unit boundary between them let a
  collapse strip `#[derive(…)]` — and the doc comment above it, which attaches to the
  attribute — off a kept declaration. Attributes (and their attached comments) now
  attach unconditionally to the following item, the way the language means them.
- **A line-comment marker must own its whole line.** Python emits
  semicolon-separated top-level statements as separate nodes, the second starting
  mid-line; a `# `-led marker replacing the first would comment out the kept one. The
  planner refuses a collapse whose range does not end at end-of-line in such languages.
- **`//go:build` is pinned to the file.** The Go spec's mandatory blank line after a
  build constraint means it can never attach to a declaration, and collapsing it
  silently changes which builds see the file — so it never collapses at all.

And one default corrected: bare `applyPlan` now follows the plan's language when
picking its marker (`markerForLanguage`), so the documented
`planStructural → applyPlan` composition keeps a python survivor parsing without the
caller wiring the marker — the same behaviour `createSmelter` already had.

**Acceptance criteria**

- [x] One fixture per language, each with a sibling collapse and a preserved doc comment (`///`, docstring, `//`). Snapshot-tested, and determinism is asserted over every fixture.
- [x] Python's significant indentation does not produce a marker that breaks the block structure of what remains. The guard reparses the post-`applyPlan` survivor with the python grammar and asserts it introduces no ERROR or missing nodes the original parse did not have.
- [x] `SUPPORTED_LANGUAGES` and `WASM_BY_LANGUAGE` stay total — adding an id without a grammar is already a compile error; kept that way (no type changed).
- [ ] Bench numbers from Slice 3 re-run and committed, per language. Follows the bench merge — Slice 3's harness lands in a sibling branch, and per-language rows are added once both are on main.

### Slice 4b — ten more structural languages — **SHIPPED**

Same machinery again: JavaScript, Java, C, C++, C#, Ruby, PHP, Kotlin, Swift and Bash,
all from grammars `tree-sitter-wasms` already prebuilds — zero new dependencies, ten
more node-kind sets in `STRUCTURE_BY_LANGUAGE`, and each grammar's licence verified
(all MIT) and recorded in `grammar-provenance.json` before it shipped.

The decisions that were not just table entries:

- **Ruby and bash read the marker itself as syntax.** The default marker _begins
  with_ `<<`, which both languages parse as a heredoc operator — a bare marker line
  does not stay a local error, it swallows every kept declaration after it into a
  string. Both languages therefore get the python treatment: the marker lands behind
  a `# ` leader (`markerForLanguage`), and the guard reparses the survivor and
  asserts no new ERROR nodes. Same wire surface, same reasoning as python.
- **More pins, same law as `//go:build`.** Shebang lines (`#!…` in bash, ruby and
  javascript — javascript's is a `hash_bang_line` node, not a comment), ruby's
  `# frozen_string_literal:` magic comment, and php's `<?php` open tag all govern
  what the file _is_, so none of them may collapse into a run. `LanguageStructure`
  grew a `pinnedTypes` set for the non-comment cases.
- **Honest words where a grammar lumps kinds together.** tree-sitter-kotlin and
  tree-sitter-swift parse structs, classes, enums, interfaces and extensions all as
  `class_declaration`; the label is `type declaration`, because calling a swift
  struct a class would be the marker overclaiming the tree. C# doc comments and C
  fixtures follow each language's own doc idiom (`///`, `/* … */`, javadoc, PHPDoc,
  KDoc, `#`).
- **A totality guard for tests themselves**
  (`test/guards/structural-totality.test.ts`): every id in `STRUCTURAL_LANGUAGES`
  must have a fixture, a committed snapshot, and a doc-comment case in
  `FIXTURE_BY_LANGUAGE` — claiming a language without tests goes red, and a mutation
  proves it.

Review of this slice found eight classes of hole, each now fixed and guarded by a
mutation:

- **Every language gets a line-comment marker leader.** The bare-marker rationale —
  "brace-delimited languages keep their structure around an unparsable line" — was
  measured and is false: reparsing every language's fixture survivor with its own
  bundled grammar showed ERROR nodes spanning the kept declarations (php also reads
  the marker's own `<<` as an operator and re-types the kept function into an
  expression operand). `MARKER_LINE_COMMENT_LEADERS` now names every structural
  language (`# ` or `// `), and the survivor-reparse guard runs for all fifteen
  fixtures. Only `'unknown'` — lexical text with no syntax to break — keeps the bare
  marker. Same wire surface as before: the leader wraps the frozen
  `<<smelt/v1: … >>` core.
- **The pin set was incomplete.** Python's shebang (a plain comment node),
  typescript/tsx's `hash_bang_line`, kotlin/swift's `shebang_line`, and c/c++'s
  `#pragma once` (a `preproc_call`, pinned by a per-type text pattern) are now
  pinned like the rest — each collapse would have silently changed what the survivor
  _is_.
- **A ruby heredoc travels as one unit.** tree-sitter-ruby emits `heredoc_body` as a
  top-level _sibling_ of the statement holding the opener, so a focus matching the
  opener could keep it while the body collapsed — an unterminated heredoc that
  swallows every kept declaration after it, and tree-sitter reports **no ERROR node**
  for it at EOF, only a zero-width `heredoc_end`. The body now extends the preceding
  unit (`ridesBackwardTypes`), and the survivor-reparse checker also flags zero-width
  tokens, so this whole failure class is visible to the guard.
- **Kotlin's import_list no longer swallows the next KDoc.** tree-sitter-kotlin
  extends the import_list node over a doc comment that directly follows it — the doc
  of the first documented declaration after the imports, which then collapsed with
  the imports. The unit now ends at the import list's last non-comment token and the
  trailing comment rides forward (`trailingCommentSplitTypes`); the kotlin fixture is
  the regression shape, KDoc directly after the imports.
- **Honest kinds for what the fallback used to call a "declaration".** C/C++
  preprocessor nodes (`preproc_call`, `preproc_if`/`preproc_ifdef`) are labelled
  `preprocessor directive`/`preprocessor conditional`; php's mixed-HTML `text` and
  `text_interpolation` nodes are `html section`; ruby's top-level control-flow blocks
  are `statement` — all counted as non-declarations by the mixed-heading rule.

**Size, measured** (2026-09-02, `ls -l packages/core/grammars/` after `pnpm build`):
the nine newly bundled grammars add **21,384,606 bytes ≈ 20.4 MiB** — cpp 4.4,
kotlin 3.9, c_sharp 3.8, swift 3.0, ruby 2.0, bash 1.3, php 0.8, c 0.8, java 0.4 MiB
(javascript, 0.6 MiB, was already bundled) — taking the whole `grammars/` directory
to 28,316,720 bytes ≈ 27.0 MiB, which is what `bundle-grammars` prints. That is the
tarball cost of "works offline" for fifteen languages; the founder accepted it when
scoping this slice.

**Acceptance criteria**

- [x] Nine new grammars bundled: `WASM_BY_LANGUAGE`, `SUPPORTED_LANGUAGES` and the extension map extended; totality stays a compile-time property (`Record<LanguageId, …>` everywhere).
- [x] `grammar-provenance.json` entries and regenerated `THIRD-PARTY.md` rows for every new grammar, licences verified against the npm registry and each repository's LICENSE file. The generator still throws on an unattributed grammar.
- [x] Per-language node-kind sets with attached doc comments in each idiom, and language-appropriate pins (shebangs in every grammar shape, `# frozen_string_literal:`, `<?php`, `#pragma once`).
- [x] One fixture per language with a sibling collapse and a preserved doc comment; snapshot and determinism per fixture; survivor-reparse assertions for **every** structural language, not just the heredoc ones.
- [x] The totality guard, with a mutation proving it goes red when a language is claimed without tests.
- [x] One tier-1 bench case through a new language (`java-classes`), so the harness proves the slice-4b path; full per-language corpus rows can follow.

### Slice 5 — a persistent elision store — **SHIPPED**

Elisions used to die with the process. A long-lived agent session outlives the process.

**Shipped as** `DirectoryElisionStore` (`src/store-dir.ts`): a second `ElisionStore` over
a content-addressed directory, `node:fs` only — SQLite would have been either a new
runtime dependency (`better-sqlite3`) or `node:sqlite`, which is not stable across the
supported engine range. The storage layout is documented on the class.

**Acceptance criteria**

- [x] A second `ElisionStore` implementation over SQLite or a content-addressed directory. The interface does not change. The reversibility and expansion-counter guards run against both stores.
- [x] Still no eviction — no cap at all, so no "evicted" error exists to need. If a size cap is genuinely required, retrieval of an evicted hash must throw a _distinct_ error that says "evicted", never `UnknownHashError` — the model must be able to tell "never existed" from "we lost it". (The class doc restates this for whoever adds a cap.) The same distinction already exists for damage: a blob whose bytes no longer hash to their name throws `StoreCorruptionError`, never `UnknownHashError`, and reads verify bytes against the hash so a torn write can never be handed back as a faithful retrieval.
- [x] Counters survive a restart: every retrieval appends one fsynced line to an append-only journal, and `stats()` is a fold over it, so `expansionRate` stays meaningful across a session.
- [x] Concurrent writers do not corrupt the store. Tested with two processes, not two promises — `test/store-dir.test.ts` spawns two real `node` subprocesses against one directory. Writes are write-temp → fsync → `link(2)` (atomic, no-clobber), and `pnpm mutate` proves the verify-on-read and counter-persistence guards can go red.

### Slice 6 — cache-prefix hygiene — **SHIPPED**

Provider prompt caches invalidate on any prefix byte change, so a context optimizer that
reorders or rewrites a prompt prefix can cost more than it saves. Headroom's CacheAligner
detects and warns about this volatility; **it never rewrites**, and neither does this.

**Shipped as** `src/cache/prefix.ts` — pure functions, zero new dependencies, exported
from the package entrypoint. Provider cache facts (byte-matched prefix over
tools → system → messages, ≈1024-token minimum, 4 breakpoints, 5 min/1 h TTL,
1.25×/2× write and ≈0.1× read pricing) are encoded as cited constants naming
Anthropic's docs and the date they were verified. Guarded by
`test/guards/cache-hygiene.test.ts`, with two mutations proving it goes red.

**Acceptance criteria**

- [x] A function that, given two successive prompt prefixes, reports the byte offset of first divergence and what changed — `findPrefixDivergence()`, UTF-8 byte offsets, excerpts that never split a multi-byte character.
- [x] Warnings only. No automatic rewriting of anybody's prompt — an optimizer that silently edits a prefix to help a cache is exactly the class of magic this library refuses. `detectCacheBreakers()` names each silent breaker (system-prompt timestamps and UUIDs, unsorted JSON keys, a tool set that varies between calls) with the `ElisionReason`-style rule id + explanation pair; the guard asserts on frozen inputs that nothing is ever mutated or "fixed".
- [x] No claim about cache hit rates anywhere. See Law 4; this is the specific claim that was wrong in the original pitch. The guard scans every source file for the phrase and a mutation proves the scan can go red.

### Slice 7 — the repo map (cross-file) — **SHIPPED**

smelt sees one blob. Aider's repo-map is the proven prior art for the other shape: whole
repository, tree-sitter tags, PageRank over the reference graph, a token budget, and a
cache.

**Shipped as** `src/repomap/` (`buildRepoMap()`, exported from the entrypoint), and
**modelled on Aider's repo-map, credited as such** — the design is Paul Gauthier's
([aider.chat/docs/repomap.html](https://aider.chat/docs/repomap.html), `aider/repomap.py`
in [Aider-AI/aider](https://github.com/Aider-AI/aider)), not this project's; the module
doc comment says so. What smelt adds is its own house rules: local files only (the walk
never follows a symlink, skips binary files, honors a caller-supplied ignore list),
deterministic ranking (fixed damping and iteration count, sorted walks, a total
tie-break by rank → path → name → line — no `Math.random`, no `Date`), and Law 2 applied
to _inclusion_: every symbol in the map carries a rule id and a sentence naming its
definition site and the measured reference counts that ranked it. The tags cache is
plain JSON keyed by content hash — Aider persists through SQLite, but this repo ships
zero new runtime dependencies — and it lives **only** in a directory the caller
explicitly hands in; a corrupt entry is deleted and reported as a warning in the result,
never trusted. Guarded by `test/guards/repo-map.test.ts`, with four mutations proving
the budget, the tie-break, cache invalidation and the corrupt-entry discard can each go
red.

**The front door: `smelt map`.** The repo map used to be exported and composed by
nothing; it now has its own CLI subcommand:

```sh
smelt map src --budget 4000 --focus handleRequest --ignore vendor --cache .smelt-tags
```

The ranked map goes to stdout, a short report (files scanned, symbols ranked, bytes
used against the budget, cache counts) to stderr, and `--json` emits the `RepoMap`
verbatim in its own versioned envelope (`smelt-map-cli/v1`). `--budget` follows the
same philosophy as everywhere else — required, no built-in default,
`defaultBudgetBytes` from `smelt.config.json` accepted, the refusal owned by
`resolveMapRun` in `src/cli/resolve.ts` (`ResolvedRun`'s sibling, not a contortion of
it — the two commands share only the budget leg, so they share the module that owns
precedence rather than a struct). `--focus` promotes matching symbols to the front of
the fill order with a `focus-match` receipt naming the term; ranks and counts are
never altered. One exit-code difference, documented in `--help`: **`map` never exits
1** — a smelt plan can come back over budget because smelt refuses to cut regions the
caller asked to keep, but the map fits itself to the budget by construction, so no
over-budget outcome exists to report. The report's "bytes used" figure is read off
`RepoMap.outputBytes` and guard-pinned to the actual stdout byte count, with mutation
`repomap-map-report-bytes-invented` proving the pin can go red.

**Deliberately NOT a planner strategy.** `buildRepoMap` returns a `RepoMap`, not an
`ElisionPlan` — nothing is elided, nothing is stored under a hash, nothing is
reversible — so it does not implement `Planner` and does not appear in the `PLANNERS`
registry. Forcing that interface would claim Law 3 about output that has no bytes to
give back; the module doc comment on `src/repomap/map.ts` states the same decision.
(A wizard step for map defaults was considered and deferred — follow-up, not scope.)

**Acceptance criteria**

- [x] Reads a repo, emits a ranked symbol map inside a byte budget. The budget is respected by construction — symbols are appended in rank order until the next line would not fit — and `outputBytes` is measured off the rendered text.
- [x] Ranking is deterministic and explainable — every included symbol can say why it ranked. Two runs are byte-identical (asserted, with and without a warm cache), and each entry's `reason` states the definition site, references in (and from how many files), and its file's references out.
- [x] Cached on disk, invalidated by content hash, no network. The key hashes format version + language + file content, so an edit is a miss by construction; the module is reachable from the entrypoint and classified by the zero-network guard.
- [x] Credits Aider's repo-map explicitly, in the code and this handoff. (The README is the founder's surface; its prior-art section is the natural home for the same credit when it is next edited.)

---

## How to run, test, lint

```sh
pnpm install
pnpm verify        # format:check → lint → typecheck → build → test → mutate
```

Individual gates: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`,
`pnpm format`, `pnpm mutate`. Generated files: `pnpm generate:third-party` rewrites
`packages/core/THIRD-PARTY.md`, and `pnpm build` refills `packages/core/grammars/` —
neither is hand-edited, and a stale `THIRD-PARTY.md` fails `pnpm test`. Fresh-clone check:
`bash scripts/check-fresh-clone.sh` (installs from `git archive` output — tracked files
only). CI runs `pnpm verify` on Node 20.19/22.12/24 plus the fresh-clone job.

### How to prove a guard can fail

This is the part not to skip, and it is why `pnpm mutate` exists:

```sh
pnpm mutate
```

It copies `packages/core/src` to a scratch tree, applies one deliberate break, points the
guard at the copy via `SMELT_GUARD_SRC`, and asserts the guard goes **red**. Every guard
file exports its own `MUTATIONS`, beside the assertions that must catch them, and the
runner discovers and counts them — the totals it prints are the measurement; a survivor
is reported as a hole in the guard, not in the mutation.

Not every guard guards source code, so there is a second mutation kind: an `artifact`
mutation stales a _committed artefact_ — `THIRD-PARTY.md`, for instance — in a scratch
root the guard reads through `SMELT_GUARD_ROOT`. Nothing in the working tree is touched
either way, which is the point: a mutation runner that edits tracked files and then
crashes leaves the repository broken, and a failure here has to be safe.

The hand-run transcript of the zero-network guard failing — a real `node:https` import and
a real `fetch()` added to `plan/lexical.ts`, the exact output, then reverted — is in
[`CONTRIBUTING.md` § "The recorded failure"](../CONTRIBUTING.md#the-recorded-failure-watching-the-zero-network-guard-go-red).
Read it before you add a guard of your own; the convention for new guards is in the same
file.

---

## The KLØDD integration contract

smelt is **used by, but not part of**, the KLØDD app. KLØDD is a consumer like any other,
and nothing in this repo depends on it, references it, or requires access to it. This
section exists so v1 can be built to a real contract without seeing that codebase.

**What a consumer depends on — the stable surface:**

```ts
import { createSmelter } from '@smeltjs/core';

const smelter = createSmelter({
  defaultBudgetBytes: 8_000,
  // store: myPersistentStore,   // optional; see Slice 5
});

// 1. Shrink tool output before it reaches the model.
const result = await smelter.smelt(toolOutput, {
  path: 'src/server.ts', // language detection
  focus: ['handleRequest'], // what the caller was actually looking for
  budgetBytes: 4_000, // per-call override
});
// → result.text            what you send
// → result.elisions        what was cut, each with rule, explanation, bytes, hash
// → result.inputBytes / result.outputBytes

// 2. Expose the retrieval tool to the model, in your own SDK's shape.
const { name, description, inputSchema, invoke } = smelter.tool;
//   name === 'smelt_retrieve'; invoke({ hash }) → the exact original bytes
//   throws UnknownHashError on an unknown hash — surface that to the model as a
//   tool error, never as empty text

// 3. Watch the honest signal.
const { expansionRate, retrieveCalls, elisionsStored, allElisionsRetrieved } = smelter.stats();
//   allElisionsRetrieved === true means every blob smelt hid was asked for again: the
//   elision saved nothing and cost a round trip. There is no threshold below that,
//   deliberately — see Decision 4.
```

**Optional: count in your own unit.** Budgets stay bytes (Decision 1). If you want tokens
in the result as well, hand smelt the counter you already have:

```ts
const smelter = createSmelter({
  defaultBudgetBytes: 8_000,
  measure: { id: 'tiktoken/o200k_base', unit: 'tokens', count: (text) => encode(text).length },
});
// → result.measured = { measure, unit, input, output }
```

**Also stable to consume: cache-prefix hygiene.** `src/cache/prefix.ts` is a
consumer-facing surface in its own right — pure functions, exported from the
entrypoint, composed with nothing else in smelt on purpose: cache hygiene is a
property of the request _you_ assemble, which smelt never sees or intercepts. Use it
from your own send path:

```ts
import { detectCacheBreakers, findPrefixDivergence } from '@smeltjs/core';

const warnings = detectCacheBreakers({ tools, system }, { tools: previousTools });
// → CacheWarning[]: a rule id + sentence per silent cache-breaker (a system-prompt
//   timestamp or UUID, unsorted tool JSON keys, a tool set that varies between
//   calls). Warnings only — your prompt is never rewritten, and no hit rate is
//   ever claimed.

const divergence = findPrefixDivergence(previousPrefix, nextPrefix);
// → undefined when the cached prefix survived (identical, or a pure append), else
//   { byteOffset, invalidatedBytes, description } — where it broke and what it cost.
```

**Also available:** the `smelt` binary, for seeing all of the above from a shell without
writing a script. `smelt <file> --budget <bytes> --focus <term>` prints the text on stdout
and the report on stderr; `--json` and `--reconstruct` round-trip through a file; and
`smelt map <dir> --budget <bytes>` renders the whole-tree ranked symbol map (Slice 7)
with the same stdout/stderr split.

**Guarantees a consumer may rely on:**

1. `smelt()` makes no network calls of its own, ever, in any version. If that changes,
   the package name changes. (A `measure` or `RerankStage` you supply is your code
   running in your process; smelt's guard covers smelt's modules, not yours.)
2. `smelt()` does not mutate its input and is deterministic for a given input, options
   and version.
3. The tool name is `smelt_retrieve` and will not be renamed.
4. Every `AppliedElision` has a non-empty `reason.rule` and `reason.explanation`.
5. `reconstruct(result)` returns the original text byte for byte, as long as the store
   still holds the bytes.
6. Every thrown error is an `instanceof SmeltError`.
7. **The marker format is stable from 0.1 and treated as 1.0.** `<<smelt/v1: … >>` will
   not change shape. A future format arrives as `smelt/v2`, identifiable in band, never
   as a quiet substitution — see Decision 3, and the guard that enforces it.
8. Budgets are UTF-8 bytes, permanently. A `Measure` you supply adds a labelled second
   number to the result; it never changes what the budget means.

**Two promises, not one.** The **wire surface a model sees** — the marker format and the
`smelt_retrieve` tool contract — is stable now. The **TypeScript API** is `0.x` and may
move: expect renames and signature changes in the type surface between minors.

**What is explicitly _not_ stable pre-1.0:** the TypeScript API, the rule ids, the
lexical planner's tuning constants, and the exact set of elisions for a given input.
A consumer that snapshot-tests smelt's output will break on a planner improvement —
snapshot the _properties_ (round-trips, under budget, focus preserved) instead. Note what
is **no longer** on this list: the marker string. It moved to the guarantees, because
consumers put it in prompts.

**What smelt will never do to a consumer:** intercept its traffic, read its config, write
outside a store it was handed, or require a key.

---

## Explicitly out of v1

**The external reranker.** A hosted reranker would improve relevance and is exactly why
`RerankStage` exists as an interface. It is out because a _default_ reranker breaks Law 1
for every consumer at once, including the ones who never read the changelog. A consumer
who wants one implements the interface in their own code, with their own key, so that the
outbound call is visible in their own source and their own review. There is no
`SMELT_RERANK_API_KEY`, no bundled adapter, and no "just set this env var" — the first of
those to appear turns a zero-network library into a library that is zero-network unless
configured, which is not the same claim.

**An example reranker in the repository.** Out (Decision 5). The README shows the snippet
and `RerankStage` is the interface; there is nothing under `examples/`, and there will not
be. The zero-network guard requires every discovered `.ts` file to be reachable from a
manifest entrypoint or explicitly justified, so a file importing an HTTP client either
breaks the guard or gets excluded from it — and **excluding a file from an honesty guard
to accommodate an example is how a guard erodes.** Naming a vendor in-repo also dates the
project: Voyage's `voyage-code-3` is already legacy.

**The learned distillation stage.** Out for a reason beyond the network: a model-written
summary cannot satisfy Law 2. "The model condensed this" is not a statement of what was
removed, and a rewritten paragraph leaves nothing to store under a hash, so Law 3 goes
too. If this ever ships, it stores the original, explains itself in the same rule-named
terms every other elision uses, and is reversible — or it does not ship.
`DistillStage` exists so that shape is written down, not so it can be filled in quietly.

**Learned localization** (SweRank, LocAgent, Agentless). Genuinely better at finding the
right code than lexical scoring, and genuinely a v2 conversation: it means a model in the
retrieval path, which is both laws again. Named in the README as prior art precisely so
nobody thinks smelt invented structural retrieval.

**Being a proxy.** A proxy can be built _on top of_ this library. The library never
intercepts requests it was not handed, because "we rewrote your agent's traffic" and "we
transformed the string you gave us" have very different failure modes and only one of
them is debuggable.

---

## Decisions the founder has made

These were the open questions. They are answered, and each answer has a home in the code
or the docs — so what follows is a record of what was decided and why, not a list of
things still to settle. Where a decision is enforced by a check, the check is named.

### 1. Budgets are UTF-8 bytes, permanently, in the core

Not a caveat. **Bytes are the only unit computable locally for every model**, which is
exactly why they are the core's unit — the same property that makes Law 1 possible.

Three facts settled it, verified against Anthropic's documentation on 2026-09-01:

- **There is no local tokenizer for Claude.** Anthropic ships only the
  `/v1/messages/count_tokens` **endpoint** — no downloadable tokenizer, no BPE
  vocabulary. A token budget inside `smelt()` would require a network call, which is
  Law 1 gone.
- **A token budget silently redefines itself across model generations.** Verbatim from
  Anthropic's docs: _"Claude 4.7 and later models and Claude Mythos Preview use a newer
  tokenizer. The same input text produces approximately 30 percent more tokens than on
  earlier models."_ A byte budget means the same thing in five years. A token budget
  quietly got 30% tighter with nothing erroring anywhere — this project's own failure
  class, arriving as someone else's model release.
- Per-provider tokenizers multiply the dependency cost on every consumer, and a coding
  agent talks to more than one provider.

**Built:** a `measure` hook on the public API (`Measure` in `src/types.ts`,
`SmelterConfig.measure`). A consumer supplies its own counter — anyone calling a model
already has one — and the result carries `measured: { measure, unit, input, output }`
alongside the byte counts. `id` and `unit` are **required**, because a token count
without the tokenizer named is not a measurement; the 30% shift above is precisely why.

The hook **does not relax Law 1.** smelt imports no transport, and the guard proves that
about smelt's modules; it cannot prove it about a function you hand in. A `count()` that
calls an API makes _your_ process call an API, from a line in _your_ source — the same
arrangement `RerankStage` already describes. `count` is synchronous on purpose: local
tokenizers are synchronous and network clients are not.

### 2. The CLI is a `bin` on `@smeltjs/core`, with zero new dependencies

`node:util.parseArgs`, stable in Node 20, which `engines` already requires. The case for
a second package was dependency-tree size, and it dissolves when the CLI adds nothing.
One package, one version, one install.

### 3. Two promises, not one — and this constrains every slice

- **The wire surface a model sees** — the marker format and the `smelt_retrieve` tool
  contract — is **stable from 0.1 and treated as 1.0.**
- **The TypeScript API** is `0.x` and may move.

Why, spelled out in `CONTRIBUTING.md` § "Two promises, not one" so a contributor does
not "clean up" the marker format: **the marker goes into prompts.** Changing it changes
model behaviour downstream and manifests as _worse output with no error anywhere_. That
is not a normal API break; it is this project's signature failure mode shipped as a
version bump.

**Built:** the marker carries its own version in band — `<<smelt/v1: … >>` — so a future
format is additive and identifiable rather than a silent substitution.
`MARKER_FORMAT_VERSION` lives in `src/apply.ts`, and
`test/guards/marker-format.test.ts` pins the exact rendering per version: the format
cannot move without the version moving, and an unknown version fails rather than
passing, so a new format is a new row and never an edit. Two mutations
(`marker-format-silent-change`, `marker-version-not-frozen`) prove both halves go red.

### 4. Measure the expansion rate; never threshold it

No default threshold. It would be a policy claim smelt has no basis for, the right rate
depends on how aggressive a budget the consumer chose, and a library printing warnings
into someone else's process is bad manners.

**Built:** `RetrieveStats.allElisionsRetrieved` — the one non-arbitrary case, exposed as
a computed fact rather than a preference. When every distinct blob smelt hid has been
asked for again, the elision achieved nothing and cost a round trip. That is arithmetic,
not an opinion, and what to do about it is the caller's call. Guarded in
`test/guards/expansion-counter.test.ts`; mutation `degenerate-outcome-never-fires` wires
the flag to a constant and the guard goes red.

### 5. No example reranker in the repo

A README snippet and the stage interface, and **nothing under `examples/`**. The
zero-network guard requires every discovered `.ts` file to be reachable from a manifest
entrypoint or explicitly justified. A file importing an HTTP client either breaks that
guard or gets excluded from it — and **excluding a file from an honesty guard to
accommodate an example is how a guard erodes.** Separately, naming a vendor in-repo
dates the project: Voyage's `voyage-code-3` is already legacy.

### 6. The grammars are bundled, and `THIRD-PARTY.md` is generated

The WASM grammars **ship inside the npm tarball** — that is what makes "zero native
compilation, works offline" true. Before this, `tree-sitter-wasms` was an _optional peer
dependency_, so a consumer installing `@smeltjs/core` got no parsers at all and found
out from a `GrammarUnavailableError` on someone else's machine. `pnpm build` copies them
into `packages/core/grammars/` and `files` packs them.

Bundling is redistribution, so attribution is required rather than polite.
`scripts/generate-third-party.mjs` produces `THIRD-PARTY.md` from installed package
metadata, the bundled files themselves, and `grammar-provenance.json` — which holds only
the facts with no machine-readable source here. It is **never hand-written**, because a
hand-written notices file is a promise that decays: a grammar gets added, the file does
not, and nothing fails. `tree-sitter-wasms` is Unlicense (the packaging); each grammar
inside carries its own licence, and all fifteen are MIT, verified against the npm
registry and each repository's `LICENSE` on the date `grammar-provenance.json`
records (2026-09-02). Even the MIT body is quoted from an installed
`LICENSE` rather than typed into the generator.

`test/guards/third-party.test.ts` reruns the real generator and fails if the committed
copy differs, so staleness is loud rather than silent. Downstream reason to get this
right: **KLØDD ships in two app stores** and takes its licence screen text from here.

### 7. npm: nothing is published, and publishing is a founder action

The `@smeltjs` org exists. Nothing has been published. **Do not publish, and do not run
`npm login`** — that is the founder's action, not an agent's.

What is done here instead: the manifest is correct for the `bin` and for the bundled
grammars, and `CONTRIBUTING.md` carries a publish checklist. The ordering rule in it
matters — **npm unpublish is restricted after 72 hours**, after which only deprecate
remains, so a premature `0.0.1` is permanent. Publish after Slice 1 lands and
`smelt --budget` actually runs on a real file, never before.

### 8. Benchmark tiers — recorded here, built in Slice 3

Recorded before Slice 3 was built, so it started from a decision rather than a
debate; the harness now implements all three tiers (tier 3 unrun — see Slice 3).
`count_tokens` is **free** — _"Token counting is free to use but subject to requests per
minute rate limits"_, 5,000 RPM at the Start tier, with limits independent of message
creation — which is what makes a three-tier split affordable:

| Tier | What it reports                   | Cost | Key needed | Who can reproduce it     |
| ---- | --------------------------------- | ---- | ---------- | ------------------------ |
| 1    | Bytes and elision counts          | none | none       | any contributor, offline |
| 2    | Token counts, via `count_tokens`  | free | any key    | anyone with a key        |
| 3    | Expansion rate — real model calls | paid | any key    | anyone, from the log     |

Tier 1 is deterministic and needs no key, so a stranger can reproduce the table's
structural half exactly. Tier 3 is the only paid part: run it once and **commit the
retrieval log as an artifact**, so the rate is verifiable from a committed file rather
than from trust.

**The trap to write down now:** tokenizers differ by model, so every table row names its
model, and re-running on a newer model is a **new row, not an edit**. See Decision 1 —
the 30% shift between Claude tokenizer generations would otherwise silently rewrite
history.

---

## `smelt init` and `smelt.config.json` (KOT-202)

The CLI has a setup wizard and a defaults file. Both are **CLI-only surfaces**: the
programmatic API never reads a config file — `createSmelter()` takes explicit
arguments, and a library whose behaviour depends on where it was invoked from would be
an invisible input.

**`smelt init`** walks through five choices — default byte budget, store (memory or a
persistent directory plus path), default planner strategy, a measure-hook stub, a
reranker stub — one question at a time. Every step accepts `back`. A re-run over an
existing config shows the current values and edits one choice at a time. **Nothing is
written until a final confirm** that lists exactly what will be written, and an
existing file is **never overwritten without an explicit per-file yes** — enforced by
`test/guards/init-wizard.test.ts`, with mutation `init-overwrite-without-consent`
proving the guard goes red. The wizard is a pure function over an input/output pair
(`runInit` in `src/cli/init.ts`), driven in-process by `test/init.test.ts`;
`bin.ts` only wires the real stdio.

**`smelt.config.json`** is versioned (`{"smeltConfig": 1, …}`) and found by walking up
from the working directory, like `package.json`. It supplies **defaults only** —
`defaultBudgetBytes`, `strategy`, `store` — and an explicit flag always wins. A
malformed config is a usage error even when every flag was given: a config silently
skipped would be a setting the user believed was in force. `test/cli-config.test.ts`
pins the precedence and the strict parse.

**The generated stubs** (`smelt.measure.ts`, `smelt.rerank.ts`) implement `Measure`
and `RerankStage` against the real exported types — `test/init-stub-typecheck.test.ts`
compiles the wizard's actual output with the real `tsc`. The reranker stub sketches
the outbound HTTP call as a marked TODO **in the consumer's file**, reading the
consumer's own env var; smelt's own import graph gains no HTTP client, and the
templates are string literals the zero-network guard's string-stripper ignores. This
does not reopen Decision 5: nothing under `examples/`, nothing in smelt's graph — the
sketch only ever exists in a file the consumer asked the wizard to write, outside this
repository.
