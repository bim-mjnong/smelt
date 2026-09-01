<div align="center">
<img src="../assets/smelt-mark.svg" width="88" alt="" />
</div>

# smelt — handoff

**Audience:** a competent engineer who has never seen this project. Read this before the
code. It says what smelt is, why each of its four laws exists, exactly what is scaffolded
versus what is yours to build, and the order to build it in.

**Status:** the spine is real and green. The two planners that make smelt interesting are
stubs that throw. Nothing has been published to npm.

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

| File                                | What it does                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/types.ts`        | The vocabulary: `Planner`, `ElisionPlan`, `AppliedElision`, `ElisionStore`, `RetrieveStats`, `RerankStage`, `DistillStage`. Read this first — the doc comments carry the reasoning.        |
| `packages/core/src/errors.ts`       | Every error is a `SmeltError`, so callers can tell "the library said no" from "something broke".                                                                                           |
| `packages/core/src/hash.ts`         | 16 hex chars of sha256. Short because the hash goes in every marker and the model pays for it.                                                                                             |
| `packages/core/src/detect.ts`       | Extension → language. `'unknown'` is a first-class answer, not a failure.                                                                                                                  |
| `packages/core/src/store.ts`        | `MemoryElisionStore`: content-addressed, dedupes, refuses hash collisions, counts retrievals.                                                                                              |
| `packages/core/src/retrieve.ts`     | `createRetrieveTool()` — the `smelt_retrieve` tool a consumer hands its model. Not MCP- or SDK-specific on purpose.                                                                        |
| `packages/core/src/apply.ts`        | `applyPlan()` (the only function that removes anything) and `reconstruct()` (Law 3 as an equation). Contains no judgement at all.                                                          |
| `packages/core/src/plan/lexical.ts` | The lexical planner: focus-window and head-tail rules, a context ladder under budget pressure, profitability check so a marker never costs more than the lines it replaces. Deterministic. |
| `packages/core/src/plan/grammar.ts` | Loads a prebuilt grammar `.wasm` off disk, through `assertLocalResource`. Cached.                                                                                                          |
| `packages/core/src/net/policy.ts`   | Law 1, written once: forbidden transports, forbidden globals, **and** the permitted sets — so the guard is a partition, not an allowlist.                                                  |
| `packages/core/src/index.ts`        | `createSmelter()` and the public surface.                                                                                                                                                  |

### Stubs that throw (by design — read `CONTRIBUTING.md` § "A stub throws")

| File                                   | Why it throws                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/plan/structural.ts` | The planner smelt is actually for. Throws rather than silently falling back to lexical, because output labelled `structural/v1` that is really line windows is undetectable from outside. **Slice 2.** |
| `packages/core/src/stages.ts`          | `unconfiguredRerankStage` and `unconfiguredDistillStage`. Both name the interface you were meant to implement. Out of v1 — see below.                                                                  |

### The honesty machinery

| File                                                  | What it guards                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/test/guards/no-network.test.ts`        | Law 1. Walks the import graph from `index.ts`; classifies every edge; also closes the vacuous-walk, unwalked-file and unvetted-dependency holes. |
| `packages/core/test/guards/reversibility.test.ts`     | Law 3. `reconstruct(smelt(x)) === x` over multi-byte, CRLF, no-trailing-newline and one-20 kB-line inputs, plus every refusal.                   |
| `packages/core/test/guards/expansion-counter.test.ts` | The retrieve counter, i.e. the observability half of Law 3.                                                                                      |
| `packages/core/test/guards/_source.ts`                | Shared source-walking helpers, including the string/comment stripper that stops `net/policy.ts` reporting its own word list.                     |
| `scripts/mutate.mjs`                                  | **The meta-guard.** Seven mutations across the three guards; each must go red. A survivor is reported as a hole in the guard.                    |
| `scripts/check-fresh-clone.sh`                        | Installs and verifies from `git archive` output — tracked files only.                                                                            |
| `.github/workflows/ci.yml`                            | `pnpm verify` on Node 20.19/22.12/24, plus the fresh-clone job.                                                                                  |

### Not built at all

- No CLI, no demo, no way to see smelt work without writing a script. **Slice 1.**
- No benchmark, so no number smelt owns. **Slice 3.**
- No persistent store, so elisions die with the process. **Slice 5.**
- No cross-file reasoning: smelt sees one blob at a time. **Slice 7.**

---

## v1, sliced

Each slice is independently shippable and independently useful. Do them in order; the
ordering is not arbitrary — Slice 1 is how you _see_ Slice 2, and Slice 3 is what lets
you claim anything about Slice 2.

### Slice 1 — the demo surface: `smelt` CLI + a report

The smallest thing that makes the library visible. One day of work.

**Build:** a `bin` on `@smeltjs/core` (or `packages/cli` — see open questions):

```sh
smelt src/server.ts --budget 4000 --focus handleRequest
smelt --budget 4000 --focus TypeError < build.log
```

Prints the smelted text to stdout, and a report to stderr so the two can be piped apart:

```
smelt  src/server.ts  typescript  lexical/v1
in 41,208 B → out 3,884 B   (-90.6%, 7 elisions)

  rule            lines  bytes  hash              explanation
  focus-window    412    18,904 a1b2c3d4e5f60718  collapsed 412 lines with no match…
  …
```

**Acceptance criteria**

- [ ] `smelt <file>` and stdin both work; `--budget` is required and its absence is an error, not a default.
- [ ] `--json` emits the `SmeltResult` verbatim, so it can be diffed in tests.
- [ ] The report totals equal `inputBytes`/`outputBytes` from the result — no separate accounting.
- [ ] `--reconstruct` reads a `--json` result back and prints the original, proving the round trip from the command line.
- [ ] Exit code is non-zero when the plan came back over budget, and says so. Never silently over budget.
- [ ] A screenshot of the built binary running on a real file is in the PR. Not the dev server, not the test output.

### Slice 2 — the structural planner, TypeScript and TSX only

The reason smelt exists. Scope it to two grammars; the machinery generalises in Slice 4.

**Build:** in `src/plan/structural.ts`, replace the throw. Parse with the language's
grammar; find nodes matching `focus`; for each match, keep its enclosing declaration —
signature, doc comment, body — and collapse its _siblings_ into one marker naming them.

**Acceptance criteria**

- [ ] `collapsed 3 sibling functions` — the explanation names the _kind_ and the _count_, from the parse tree, not a line count.
- [ ] A kept declaration keeps its signature line and attached doc comment, always. A fixture asserts this on a file where the doc comment is 40 lines long.
- [ ] Ranges never split a multi-byte character and never cross a node boundary. The reversibility guard already covers the first; add a fixture for the second.
- [ ] Grammar load failure throws `GrammarUnavailableError`. It does **not** fall back to lexical. A caller who wants the fallback asks for it.
- [ ] Deterministic: same file, same focus, byte-identical plan. Asserted, not assumed.
- [ ] A snapshot test per fixture, so a plan change shows up as a reviewable diff.
- [ ] `pnpm mutate` gains a mutation for whatever new guarantee this slice claims.

### Slice 3 — the measurement harness

The slice that lets smelt say a number. Until this exists, Law 4 forbids all of them.

**Build:** `packages/core/bench/` — a corpus of real tool outputs (files, greps, stack
traces, `cargo build` output), a set of realistic tasks with known answers, and a runner
that reports, per case: input bytes, output bytes, elisions, and — critically —
**expansion rate**, by actually asking a model and counting its `smelt_retrieve` calls.

**Acceptance criteria**

- [ ] The corpus is committed, or fetched from a pinned public commit. Reproducible by a stranger.
- [ ] Reports bytes _and_ tokens. If a tokenizer dependency is unacceptable (see open questions), report bytes and say so rather than converting with a fudge factor.
- [ ] Reports expansion rate per case, and the aggregate. A case where the model retrieved everything back is reported as a **loss**, with its input.
- [ ] Output is a committed markdown table with the date, the corpus commit, and the model used. A number without those three is not a measurement.
- [ ] The README's numbers section is written from this table or stays empty. No rounding up, no "up to".
- [ ] The harness has no network access on the smelt side. Model calls are the harness's, made explicitly, outside the library.

### Slice 4 — structural planning for Rust, Python and Go

Same machinery, three more node-kind sets.

**Acceptance criteria**

- [ ] One fixture per language, each with a sibling collapse and a preserved doc comment (`///`, docstring, `//`).
- [ ] Python's significant indentation does not produce a marker that breaks the block structure of what remains. A fixture asserts the survivor still parses.
- [ ] `SUPPORTED_LANGUAGES` and `WASM_BY_LANGUAGE` stay total — adding an id without a grammar is already a compile error; keep it that way.
- [ ] Bench numbers from Slice 3 re-run and committed, per language.

### Slice 5 — a persistent elision store

Elisions currently die with the process. A long-lived agent session outlives the process.

**Acceptance criteria**

- [ ] A second `ElisionStore` implementation over SQLite or a content-addressed directory. The interface does not change.
- [ ] Still no eviction. If a size cap is genuinely required, retrieval of an evicted hash must throw a _distinct_ error that says "evicted", never `UnknownHashError` — the model must be able to tell "never existed" from "we lost it".
- [ ] Counters survive a restart, or the docs state plainly that they do not.
- [ ] Concurrent writers do not corrupt the store. Test it with two processes, not two promises.

### Slice 6 — cache-prefix hygiene

Provider prompt caches invalidate on any prefix byte change, so a context optimizer that
reorders or rewrites a prompt prefix can cost more than it saves. Headroom's CacheAligner
detects and warns about this volatility; **it never rewrites**, and neither should this.

**Acceptance criteria**

- [ ] A function that, given two successive prompt prefixes, reports the byte offset of first divergence and what changed.
- [ ] Warnings only. No automatic rewriting of anybody's prompt — an optimizer that silently edits a prefix to help a cache is exactly the class of magic this library refuses.
- [ ] No claim about cache hit rates anywhere. See Law 4; this is the specific claim that was wrong in the original pitch.

### Slice 7 — the repo-map planner (cross-file)

smelt sees one blob. Aider's repo-map is the proven prior art for the other shape: whole
repository, tree-sitter tags, PageRank over the reference graph, a token budget, and a
cache.

**Acceptance criteria**

- [ ] Reads a repo, emits a ranked symbol map inside a byte budget.
- [ ] Ranking is deterministic and explainable — every included symbol can say why it ranked.
- [ ] Cached on disk, invalidated by content hash, no network.
- [ ] Credits Aider's repo-map explicitly, in the code and the README.

---

## How to run, test, lint

```sh
pnpm install
pnpm verify        # format:check → lint → typecheck → build → test → mutate
```

Individual gates: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`,
`pnpm format`, `pnpm mutate`. Fresh-clone check:
`bash scripts/check-fresh-clone.sh` (installs from `git archive` output — tracked files
only). CI runs `pnpm verify` on Node 20.19/22.12/24 plus the fresh-clone job.

### How to prove a guard can fail

This is the part not to skip, and it is why `pnpm mutate` exists:

```sh
pnpm mutate
```

It copies `packages/core/src` to a scratch tree, applies one deliberate break, points the
guard at the copy via `SMELT_GUARD_SRC`, and asserts the guard goes **red**. Seven
mutations across three guards; a survivor is reported as a hole in the guard, not in the
mutation.

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
const { expansionRate, retrieveCalls, elisionsStored } = smelter.stats();
```

**Guarantees a consumer may rely on:**

1. `smelt()` makes no network calls, ever, in any version. If that changes, the package
   name changes.
2. `smelt()` does not mutate its input and is deterministic for a given input, options
   and version.
3. The tool name is `smelt_retrieve` and will not be renamed.
4. Every `AppliedElision` has a non-empty `reason.rule` and `reason.explanation`.
5. `reconstruct(result)` returns the original text byte for byte, as long as the store
   still holds the bytes.
6. Every thrown error is an `instanceof SmeltError`.

**What is explicitly _not_ stable pre-1.0:** the default marker string, the rule ids, the
lexical planner's tuning constants, and the exact set of elisions for a given input.
A consumer that snapshot-tests smelt's output will break on a planner improvement — snapshot
the _properties_ (round-trips, under budget, focus preserved) instead.

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

## Open questions the founder owns

1. **npm.** `@smeltjs` is free; bare `smelt` is squatted by a dead 2015 package and
   `@smelt` is taken. Nothing is published — the manifest is correct and stopping there
   was deliberate. Who creates the org, and does `@smeltjs/core` publish before or after
   Slice 2 lands?
2. **One package or two.** Does the CLI (Slice 1) ship as a `bin` on `@smeltjs/core`, or
   as `@smeltjs/cli`? A `bin` is simpler; a second package keeps the library's dependency
   tree at exactly two.
3. **Tokens or bytes.** Budgets are UTF-8 bytes today, which is honest and dependency-free
   but not what anyone is billed in. Taking a tokenizer dependency (tiktoken/tokenizers) is
   a real cost imposed on every consumer, and per-provider tokenizers multiply it. Bytes
   with a documented caveat, or tokens behind an optional peer dependency?
4. **The default expansion-rate threshold.** smelt measures the rate but ships no
   threshold, because it has not measured one. After Slice 3, is there a number worth
   warning at — and is warning even smelt's job, or the consumer's?
5. **An example reranker in-repo.** Would a `examples/rerank-voyage.ts` help adoption, or
   would its presence in the repo undermine the zero-network claim in readers' minds
   regardless of what the docs say?
6. **Grammar licensing surface.** `tree-sitter-wasms` is Unlicense, but the individual
   grammars inside it carry their own (mostly MIT) licences. Does the release need a
   `THIRD-PARTY.md` enumerating them, and who signs off?
7. **SemVer pre-1.0.** The contract section above lists six guarantees and four
   deliberately unstable things. Is `0.x` with that split the right promise, or should
   the marker format be frozen earlier because consumers will put it in prompts?
8. **Where the benchmark's model calls come from.** Slice 3 needs a model to produce an
   honest expansion rate. Whose key, run where, and how does a contributor reproduce the
   table without one?
