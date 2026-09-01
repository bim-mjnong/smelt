<div align="center">

<img src="assets/smelt-wordmark.svg" width="360" alt="smelt" />

**Structure-aware, reversible context optimization for coding agents.**
A library, not a proxy.

[![CI](https://img.shields.io/github/actions/workflow/status/mong-x/smelt/ci.yml?style=for-the-badge&logo=githubactions&logoColor=EFEBE5&label=CI&labelColor=131417&color=E4602F)](https://github.com/mong-x/smelt/actions/workflows/ci.yml)
[![network calls](https://img.shields.io/badge/network_calls-0-E4602F?style=for-the-badge&labelColor=131417)](#the-four-laws)
[![node](https://img.shields.io/badge/node-%5E20.19_%7C%7C_%3E%3D22.12-6E7783?style=for-the-badge&logo=nodedotjs&logoColor=EFEBE5&labelColor=131417)](#requirements)
[![License](https://img.shields.io/badge/license-Apache_2.0-6E7783?style=for-the-badge&labelColor=131417)](./LICENSE)

**Status: pre-alpha.** The pipeline, the lexical planner and the `smelt` CLI are real and
tested. The structural planner is a stub that throws. **Not published to npm.** Read
[`docs/HANDOFF.md`](docs/HANDOFF.md) before building on it.

</div>

## Introduction

**smelt shrinks what your coding agent sends to a model, without lying about what it
removed.**

Hand it a blob of text — a file, a grep result, a stack trace, a build log — and a byte
budget. It gives you back a smaller blob in which the parts the task needs survive, and
everything else has been replaced by a single line saying what went, how big it was, and a
hash to get it back:

```
<<smelt/v1: collapsed 412 lines with no match for the focus terms (18904B) — retrieve("a1b2c3d4e5f60718")>>
```

The removed bytes are kept locally, content-addressed. The model gets a `smelt_retrieve`
tool. **Every retrieval is counted**, so cutting too much shows up as a rising number
rather than as a model that is quietly wrong about your code.

**Who it is for:** people building coding agents who are tired of a 40 kB grep result
eating a third of the context window — and who are not willing to solve that by shipping
their users' source to a third-party summariser.

- 🔒 **Zero network.** No external calls, in any code path, enforced by a test that walks the real import graph. Structural (tree-sitter WASM) and lexical scoring only.
- 🗣️ **Every elision explains itself.** A named rule and a sentence a human can read in a diff. If a rule cannot say what it removed, the rule does not ship.
- ↩️ **Every elision is reversible.** `reconstruct(smelt(x)) === x`, byte for byte, asserted on multi-byte text, CRLF, and files with no trailing newline.
- 📈 **Over-pruning is measurable.** `smelter.stats().expansionRate` — the fraction of what smelt hid that the model had to ask back for. The honest signal, and the one nobody publishes.
- 🧪 **Guards that have been watched failing.** `pnpm mutate` breaks the source on purpose and fails if a guard does not notice. 12 mutations, 5 guards, 12 caught.
- 🪶 **One runtime dependency.** `web-tree-sitter`. The parsers themselves ship inside the tarball, so there is no native build step, no post-install download, no Docker and no service.
- ⌨️ **A CLI, so you can see it work.** `smelt <file> --budget 4000 --focus handleRequest`. Text on stdout, report on stderr, no new dependencies.

| What your agent does today                         | What smelt does instead                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| Sends the whole 40 kB file, or its first 200 lines | Keeps the declarations your focus matched, with their signatures and doc comments |
| `[...output truncated...]`                         | `<<smelt/v1: collapsed 412 lines with no match … (18904B) — retrieve("a1b2…")>>`  |
| Truncated content is gone                          | Stored locally, keyed by hash, one tool call away                                 |
| No idea whether the cut hurt                       | An expansion rate you can watch move                                              |
| Asks a hosted model which lines matter             | Never leaves the machine                                                          |

## On numbers

**smelt publishes no savings figures, because it has not measured any yet.** That is a
rule rather than an oversight — see
[Law 4](docs/HANDOFF.md#law-4--claim-no-number-that-has-not-been-measured).

What is honest to say about the _class_ of saving to expect: the closest comparable is
**Headroom's own stated 15–20% token reduction for coding agents** — its 60–95% figures
apply to narrow content types like JSON logs, not to code. LLMLingua's ~20× compression
results are on non-code benchmarks. Both are other people's numbers, on other people's
corpora, and are cited here as exactly that.

A figure worth checking whenever you see it in this space: a "90%+ cache hit rate" is
usually Anthropic's 0.1× _price_ for a cached read, which is a price and not a rate. When
smelt has a harness ([Slice 3](docs/HANDOFF.md#slice-3--the-measurement-harness)) and its
own table — with a date, a corpus commit, and a model named — it will state that number
and nothing beyond it.

## On units: bytes, and why that is the strength

**Budgets are UTF-8 bytes, permanently, and that is a design decision rather than a
limitation.** Bytes are the only unit that can be computed **locally, for every model** —
which is the same property that makes the zero-network guarantee possible at all. A
context optimizer whose budget requires a round trip is not offline.

The specifics, verified against Anthropic's documentation on 2026-09-01:

- **There is no local tokenizer for Claude.** Anthropic ships the
  `/v1/messages/count_tokens` **endpoint** — not a downloadable tokenizer and not a BPE
  vocabulary. A token budget inside `smelt()` would mean a network call on every call.
- **A token budget silently redefines itself between model generations.** Anthropic's own
  words: _"Claude 4.7 and later models and Claude Mythos Preview use a newer tokenizer.
  The same input text produces approximately 30 percent more tokens than on earlier
  models."_ A byte budget means the same thing in five years. A token budget quietly got
  30% tighter with nothing erroring anywhere — which is exactly the class of failure this
  library exists to refuse.
- Per-provider tokenizers multiply the dependency cost on every consumer, and a coding
  agent rarely talks to only one provider.

**If you want the number in your own unit, bring your own counter.** You already have one
if you are calling a model:

```ts
import { encode } from 'gpt-tokenizer'; // or any local tokenizer you already ship

const smelter = createSmelter({
  defaultBudgetBytes: 8_000,
  measure: {
    id: 'gpt-tokenizer/o200k_base', // names the counter — a token count without one is not a measurement
    unit: 'tokens',
    count: (text) => encode(text).length,
  },
});

const result = await smelter.smelt(toolOutput, { budgetBytes: 4_000 });
result.measured; // { measure: 'gpt-tokenizer/o200k_base', unit: 'tokens', input, output }
```

`id` and `unit` are required on purpose: given the 30% shift above, `1,204 tokens` is not
a fact and `1,204 tokens (claude-4.7/count_tokens)` is.

**This hook does not relax the zero-network guarantee, and it does not pretend to.** smelt
imports no transport, and its guard proves that about smelt's own modules; it cannot prove
it about a function you hand in. A `count()` that calls an API makes _your_ process call an
API, from a line in _your_ source — the same arrangement as `RerankStage` below. `count` is
synchronous, which is why local tokenizers fit it and HTTP clients do not.

## The CLI

```sh
smelt src/server.ts --budget 4000 --focus handleRequest
smelt --budget 4000 --focus TypeError < build.log
```

Smelted text goes to **stdout**, the report to **stderr**, so the two pipe apart:
`smelt big.log --budget 4000 > small.log`.

![the smelt CLI running on a real file](docs/images/slice-1-cli.png)

```
smelt  packages/core/src/plan/lexical.ts  typescript  lexical/v1
in 7,297 B → out 985 B   (-86.5%, 3 elisions)

  rule          lines  bytes  hash              explanation
  focus-window     53  2,224  84998967370f38bc  collapsed 53 lines with no match for the focu…
  focus-window      4    253  cb63542ad561a25d  collapsed 4 lines with no match for the focus…
  focus-window    128  4,155  786640c78c602123  collapsed 128 lines with no match for the foc…
```

- `--budget` is **required**. Its absence is an error, not a default — see below.
- `--json` prints a versioned envelope: the `SmeltResult` verbatim, plus the elided bytes.
- `--reconstruct` reads that envelope back and prints the original, byte for byte. Law 3,
  from a shell.
- The **exit code is non-zero when the plan came back over budget**, and the report says
  so. smelt does not cut the regions you asked to keep in order to make a number look
  right, and it does not hide that it did not. `1` over budget, `2` usage, `3` refused,
  `4` unexpected.

It ships as a `bin` on the library rather than a second package, because
`node:util.parseArgs` is in Node's standard library: the CLI adds no dependency, so the
only argument for splitting it out disappeared.

## Reranking: a seam, not a feature

There is no bundled reranker and there is no `examples/` directory — deliberately, on both
counts. A default reranker would ship every consumer's source to a third party, including
the consumers who never read the changelog. And an example that imports an HTTP client
would either break the zero-network guard or have to be excluded from it, and excluding a
file from an honesty guard to accommodate an example is how a guard erodes.

The interface is the whole offering. Implement it in your code, with your key, so the
outbound call is visible in your own diff and your own review:

```ts
import type { RerankStage } from '@smeltjs/core';

const myReranker: RerankStage = {
  id: 'my-hosted-reranker',
  async rerank(candidates, query) {
    // Your call, your key, your process. Visible here, in your source.
    const scored = await myClient.rerank({ query, documents: candidates.map((c) => c.text) });
    return scored.map(({ index, score }) => ({ ...candidates[index]!, score }));
  },
};
```

## Requirements

- **Node** `^20.19 || >=22.12`
- **pnpm** 10.15, for development
- Nothing else. No database, no Docker, no compiler, no API key.

## Installation

Not on npm yet; publishing is deliberately a human action. Until then:

```sh
git clone https://github.com/mong-x/smelt.git && cd smelt
pnpm install && pnpm verify
```

Then depend on `packages/core` directly, or `pnpm build` and link `dist/`. The CLI runs
straight out of the build:

```sh
node packages/core/dist/cli/bin.js src/server.ts --budget 4000 --focus handleRequest
```

## Usage

```ts
import { createSmelter } from '@smeltjs/core';

const smelter = createSmelter({ defaultBudgetBytes: 8_000 });

// 1. Shrink tool output on its way to the model.
const result = await smelter.smelt(toolOutput, {
  path: 'src/server.ts', // language detection
  focus: ['handleRequest'], // what you were actually looking for
  budgetBytes: 4_000,
});

result.text; // send this
result.elisions; // what was cut: rule, explanation, bytes, hash — per elision
result.outputBytes; // check it: the budget is a target, never a silent guarantee

// 2. Give the model the way back.
const { name, description, inputSchema, invoke } = smelter.tool;
//   name === 'smelt_retrieve'  →  invoke({ hash }) returns the exact original bytes

// 3. Watch whether you cut too much.
smelter.stats().expansionRate; // 0 = the model never needed anything back
```

Two things that look like bugs and are not:

- **`budgetBytes` is required.** There is no default, because a budget smelt invented
  would be smelt deciding how much of your context to throw away.
- **`strategy: 'structural'` throws.** It is not built yet, and it refuses rather than
  quietly returning line-window output labelled `structural/v1`. See
  [`CONTRIBUTING.md` § "A stub throws"](CONTRIBUTING.md#1-a-stub-throws).
- **There is no expansion-rate warning.** smelt measures the rate and ships no threshold,
  because a threshold is a policy claim it has not measured and printing warnings into
  your process is not its business. The one non-arbitrary case is a computed fact:
  `stats().allElisionsRetrieved` is true when every blob smelt hid was asked for again, so
  the elision saved nothing and cost a round trip. What to do about that is yours.

## Two stability promises, not one

- **The wire surface a model sees is stable from 0.1 and treated as 1.0.** That is the
  marker format — `<<smelt/v1: … >>` — and the `smelt_retrieve` tool contract. The marker
  carries its own version in band, so a future format is additive and identifiable rather
  than a silent replacement.
- **The TypeScript API is `0.x` and may move.** Expect renames and signature changes
  between minors.

The split is not bureaucracy. **The marker goes into prompts.** Changing its shape changes
model behaviour in every consumer, and that shows up as _worse output with no error
anywhere_ — no exception, no failing test, no log line. That is not a normal API break;
it is this project's signature failure mode arriving as a version bump, which is the one
thing smelt must never do to the people using it. `pnpm mutate` includes a mutation that
changes the marker without changing its version, and the guard goes red.

## The four laws

Every one is load-bearing, and the reasoning — _why_ breaking each produces a library that
still looks like it works — is in
[`docs/HANDOFF.md`](docs/HANDOFF.md#the-four-laws-and-why-each-one-is-load-bearing). In
short:

1. **Zero network.** No external calls in v1. Reranking is a stage interface you wire your
   own key into — never a default, never bundled.
2. **Every elision is explainable.** A named rule and a sentence. Never a model's opinion.
3. **Every elision is reversible**, and **expansions are counted**. Reversibility without
   counting is how "90% reduction" gets claimed while the model quietly asks for all of it
   back.
4. **Claim no number that has not been measured.** Absolute.

## What is built, and what is not

|                         |                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✅ **Built and tested** | The plan/apply/store/retrieve pipeline · the lexical planner (focus windows, head-tail, budget ladder) · the retrieve tool and expansion counters · bundled grammars and generated attribution · the `smelt` CLI · five mutation-tested guards · CI · fresh-clone verification |
| 🚧 **Stubs that throw** | The structural planner · the rerank stage · the distill stage                                                                                                                                                                                                                  |
| 📋 **Not started**      | Benchmark harness, persistent store, cache-prefix hygiene, cross-file repo map — each sliced with acceptance criteria in [`docs/HANDOFF.md`](docs/HANDOFF.md#v1-sliced)                                                                                                        |

## Prior art, credited honestly

smelt's architecture is **close to Headroom's**, and it would be dishonest to imply
otherwise.

- **[Headroom](https://github.com/headroomlabs-ai/headroom)** (Apache-2.0, large and
  active) — Python, plus a library-only TypeScript SDK. Its **CCR** is the same shape as
  smelt's core: a local store, a `headroom_retrieve` tool, BM25 retrieval. Its
  **CacheAligner** detects and warns about cache-busting prompt volatility and
  deliberately never rewrites — a decision smelt copies outright in
  [Slice 6](docs/HANDOFF.md#slice-6--cache-prefix-hygiene). Headroom's README is also the
  source of the only honest token-reduction figure quoted above. If you need this today,
  and in Python, use Headroom.
- **[Aider's repo-map](https://aider.chat/2023/10/22/repomap.html)** — the proven prior art
  for tree-sitter tags + PageRank + a token budget + a SQLite cache. There is no better
  reference for the cross-file problem, which is why
  [Slice 7](docs/HANDOFF.md#slice-7--the-repo-map-planner-cross-file) is modelled on it
  explicitly.
- **[LLMLingua](https://github.com/microsoft/LLMLingua)** — the prompt-compression research
  line. Its headline numbers are on non-code benchmarks; its framing of compression as a
  budgeted selection problem shaped how smelt thinks about plans.
- **[SweRank](https://arxiv.org/abs/2505.07849)**,
  **[LocAgent](https://arxiv.org/abs/2503.09089)**,
  **[Agentless](https://github.com/OpenAutoCoder/Agentless)** — learned code localization.
  Better at finding the right code than any lexical rule, and a v2 conversation because
  each one puts a model in the retrieval path. Named here so nobody mistakes smelt for
  having invented structural retrieval.
- **[Tree-sitter](https://tree-sitter.github.io/)** — the parsers under all of it.

**What smelt actually adds** — and this is the whole list: the **zero-network guarantee**,
the requirement that **every elision explains itself in named-rule terms**, and the
**mutation-tested honesty machinery** that makes both claims checkable instead of
aspirational. No novelty is claimed in structural retrieval, content-addressed recall, or
prompt compression.

## Relationship to KLØDD

smelt is **used by, but not part of**, the KLØDD app. KLØDD is a consumer like any other:
nothing in this repository depends on it, references its internals, or needs access to it.
The contract a consumer relies on is written out in full in
[`docs/HANDOFF.md`](docs/HANDOFF.md#the-klødd-integration-contract), so anyone can
build against the same surface. smelt is developed and released on its own terms.

## Documentation

| Doc                                                            | What is in it                                                                                                                                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/HANDOFF.md`](docs/HANDOFF.md)                           | The full picture: the four laws and their reasoning, what is scaffolded file by file, v1 sliced with acceptance criteria, the consumer contract, what is out of v1 and why, and the open questions |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                           | Dev setup, the three silence rules, the mutation convention, and the recorded transcript of the zero-network guard going red                                                                       |
| [`assets/PALETTE.md`](assets/PALETTE.md)                       | The palette, the marks, and how to regenerate the rasters                                                                                                                                          |
| [`packages/core/THIRD-PARTY.md`](packages/core/THIRD-PARTY.md) | Generated attribution for everything smelt redistributes — the bundled tree-sitter grammars and their licences. Never hand-edited; a stale copy fails `pnpm test`.                                 |

## Contributing

Contributions welcome — planners, languages, docs, and especially the benchmark. Read
[`CONTRIBUTING.md`](CONTRIBUTING.md) first: the dev setup is two commands, but the
convention around _guards that can fail_ is the part that matters and the part that is
easiest to break by accident. `pnpm verify` is the gate; Conventional Commits.

## License

[Apache-2.0](./LICENSE).

<div align="center">
<br />
<img src="assets/smelt-mark.svg" width="40" alt="" />
<br />
<sub>Cut hard. Explain everything. Keep the ore.</sub>
</div>
