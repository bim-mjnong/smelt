# Contributing to smelt

Bug fixes, planners, languages, docs — all welcome. Before you write code, read the four
laws in [`docs/HANDOFF.md`](docs/HANDOFF.md#the-four-laws-and-why-each-one-is-load-bearing).
They are not style preferences. Each one exists because breaking it produces a library
that _looks_ like it works, and a contributor acting in good faith will break them
helpfully unless they know why they are there.

## Dev setup

```sh
git clone https://github.com/mong-x/smelt.git && cd smelt
pnpm install
pnpm verify        # the whole gate: format, lint, typecheck, build, test, mutate
```

Node `^20.19 || >=22.12`, pnpm 10.15. No native compilation, no Docker, no services.
`web-tree-sitter` is WASM and the grammars are prebuilt `.wasm` blobs, so there is
nothing to build and nothing to download at runtime.

| Command                             | What it does                                                           |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `pnpm verify`                       | Everything below, in order, one verdict. **This is the green signal.** |
| `pnpm build`                        | `tsc` per package into `dist/`, then bundles the grammars              |
| `pnpm test`                         | vitest, all packages                                                   |
| `pnpm typecheck`                    | `tsc --noEmit`, including tests                                        |
| `pnpm lint`                         | oxlint, warnings are errors                                            |
| `pnpm format` / `pnpm format:check` | prettier                                                               |
| `pnpm mutate`                       | the mutation suite — see below                                         |
| `pnpm generate:third-party`         | rewrites `packages/core/THIRD-PARTY.md` (never edit it by hand)        |
| `bash scripts/check-fresh-clone.sh` | installs and verifies from `git archive` output (tracked files only)   |

### Generated files

Two things in this repository are generated, and neither is ever hand-edited:

- **`packages/core/grammars/*.wasm`** — filled by `pnpm build` from `tree-sitter-wasms`,
  gitignored, and packed into the tarball via `files`. This is what makes "no native
  compilation, works offline" true for someone who just `npm install`s the package.
- **`packages/core/THIRD-PARTY.md`** — produced by `scripts/generate-third-party.mjs`
  from installed package metadata, the bundled files, and `grammar-provenance.json`.
  Bundling the grammars is redistribution, so attribution is required; generating it is
  how the attribution stays true when a grammar is added. A stale copy fails `pnpm test`.
  The generator emits the file already in prettier's formatting, so `pnpm format` (or an
  editor's format-on-save, from any directory) is a no-op on it and can never make the
  committed copy disagree with the generator.

### Trying the CLI

```sh
pnpm build
node packages/core/dist/cli/bin.js packages/core/src/plan/lexical.ts --budget 2000 --focus planLexical
```

Text on stdout, report on stderr. `--json` prints an envelope you can feed back with
`--reconstruct` to prove the round trip from a shell.

## Silence is the enemy

smelt's characteristic failure mode is one where **the failure and the success look
identical**. A compressor that drops the wrong lines still returns plausible text. A
retrieve counter that never increments still reports a number. A guard that walks an
empty graph still goes green. None of those announce themselves; you find out weeks
later, from a model that is subtly wrong about a file.

Three rules follow, and they are enforced rather than encouraged.

### 1. A stub throws

Never return `[]`, never return the input unchanged, never fall back to a planner that
happens to work. A stub that returns something plausible is indistinguishable from a
working implementation with nothing to say, and someone will ship it.

```ts
throw new NotImplementedError(
  'reranking',
  'docs/HANDOFF.md § "Explicitly out of v1" — implement `RerankStage` in your own ' +
    'code, with your own key, so the network call is visible in your source',
);
```

The error names _what_ is missing and _where to read about it_. `test/stubs.test.ts`
asserts every stub throws, and that asking a smelter for a strategy that does not exist
fails loudly instead of quietly falling back to the lexical planner.

### 2. Where the code claims a guarantee, a test enforces it

"Reversible", "rejected", "impossible", "always local" are assertions about behaviour.
If a comment says one, a test asserts it or the comment gets reworded. `reconstruct()`
does not _document_ reversibility; `test/guards/reversibility.test.ts` asserts
`reconstruct(smelt(x)) === x`, byte for byte, over multi-byte text, CRLF, a file with no
trailing newline, and one 20 kB line.

### 3. A guard nobody has watched fail is not a guard

Every guard ships with at least one **mutation**: a specific break in the source that the
guard must catch. `pnpm mutate` copies `packages/core/src` to a scratch tree, applies one
mutation, points the guard at the copy via `SMELT_GUARD_SRC`, and asserts the guard goes
**red**. A mutation the guard survives is reported as a hole in the _guard_.

```
$ pnpm mutate

=== pristine source: every guard must be green ===

  PASS  test/guards/no-network.test.ts
  PASS  test/guards/reversibility.test.ts
  PASS  test/guards/expansion-counter.test.ts
  PASS  test/guards/marker-format.test.ts
  PASS  test/guards/third-party.test.ts
  PASS  test/guards/persistent-store.test.ts
  PASS  test/guards/cache-hygiene.test.ts
  PASS  test/guards/structural.test.ts
  PASS  test/guards/structural-totality.test.ts
  PASS  test/guards/bench-results.test.ts
  PASS  test/guards/repo-map.test.ts
  PASS  test/guards/init-wizard.test.ts

=== mutations: every guard must go red ===

  CAUGHT  law1-node-https-import
           mutation: a network transport imported directly into the elision path
           guard:    test/guards/no-network.test.ts
           red on:   AssertionError: Law 1 violation: smelt v1 makes zero network calls: expected [ Array(1) ] to deeply equal []
  …
=== 52/52 mutations caught across 12 guards ===
```

**Adding a guard? The convention is three steps:**

1. Import the library through `@guard/…` rather than a relative path, so the alias in
   `packages/core/vitest.config.ts` can be redirected at a broken copy. If your guard
   reads a _committed artefact_ rather than source, read it through `guardRoot()` from
   `test/guards/_source.ts` so it can be redirected too.
2. Add an entry to `MUTATIONS` in `scripts/mutate.mjs`: the guard it must break, the
   exact source string to change, and _why that break matters_. A guard over an artefact
   takes `kind: 'artifact'` and its `file` is relative to `packages/core`.
3. Run `pnpm mutate`. If the guard survives, the guard is wrong — fix the guard, not the
   mutation.

The `find` anchor must match **exactly once**. A mutation that silently no-ops because
the source moved is the same class of bug the guards exist to catch, so it is a hard
error rather than a warning.

Nothing a mutation does touches the working tree. Source mutations go to a copy of `src`;
artefact mutations copy the one file into a scratch root. A runner that edited tracked
files and then crashed would leave the repository broken, which is the opposite of what a
safe-to-fail check is for.

The twelve guards today, and what each one would let through if it stopped working:

| Guard                                | If it silently stopped working                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `guards/no-network.test.ts`          | source leaving the machine — including from the CLI, a second front door                                                              |
| `guards/reversibility.test.ts`       | `reconstruct()` returning almost-right text                                                                                           |
| `guards/expansion-counter.test.ts`   | the expansion rate pinned at a flattering zero                                                                                        |
| `guards/marker-format.test.ts`       | the marker changing shape in everyone's prompts, with no error anywhere                                                               |
| `guards/third-party.test.ts`         | a bundled grammar being redistributed with no licence notice                                                                          |
| `guards/cache-hygiene.test.ts`       | cache hygiene quietly rewriting prompts, or a hit-rate claim reappearing                                                              |
| `guards/structural.test.ts`          | structural markers that mislabel, cut, or approximate what the parse tree says                                                        |
| `guards/repo-map.test.ts`            | a repo map that overruns its budget, reorders on rank ties, serves stale tags after an edit, or silently trusts a corrupt cache entry |
| `guards/persistent-store.test.ts`    | a damaged blob handed back as a faithful retrieval, or retrieval counters that reset to zero on restart                               |
| `guards/structural-totality.test.ts` | a language claimed by the planner with no fixture, snapshot or doc-comment case behind it                                             |
| `guards/bench-results.test.ts`       | an edited or extrapolated results row, a network call in the offline tier, or `bench/` slipping into the tarball                      |
| `guards/init-wizard.test.ts`         | `smelt init` overwriting a hand-written file without an explicit per-file yes                                                         |

## Two promises, not one

**Read this before you "clean up" the marker format.**

smelt makes two stability promises with different strengths, and the split is not
bureaucracy:

- **The wire surface a model sees is stable from 0.1 and treated as 1.0.** That is the
  marker format — `<<smelt/v1: … (412B) — retrieve("…")>>` — and the `smelt_retrieve`
  tool contract.
- **The TypeScript API is `0.x` and may move.** Renames and signature changes between
  minors are expected.

Why the wire surface is the strict one: **the marker goes into prompts.** Changing it
changes model behaviour downstream, in every consumer, and that manifests as _worse
output with no error anywhere_ — no exception, no failing test on their side, no line in
a log. It is not a normal API break. It is this project's signature failure mode shipped
as a version bump, which is precisely the thing smelt exists to refuse to do to people.

So the marker carries its own version **in band**, and `MARKER_FORMAT_VERSION` in
`src/apply.ts` is the single source of it. A future format is _additive and
identifiable_: `smelt/v2` markers can sit next to `smelt/v1` ones in a transcript and a
consumer parsing them can tell which is which. It is never a substitution.

`test/guards/marker-format.test.ts` enforces exactly that. It pins the rendered marker
per version, so the format cannot move unless the version moves; and it fails on a
version it does not know, so a new format has to arrive as a **new row, never an edit** —
old markers stay valid in caches, transcripts and other people's prompts forever.

If you need a different marker for your own use, pass `marker` to `createSmelter()`. That
is your format in your process, and nothing here is in your way.

## Publishing (a founder action)

**Do not publish. Do not run `npm login`.** Publishing `@smeltjs/core` is the founder's
action, not a contributor's and not an agent's. This checklist exists so the ordering is
decided before anyone is standing at the keyboard.

**The ordering rule, and why it is a rule:** npm restricts unpublishing after **72
hours** — after that only `npm deprecate` remains. The first publish is therefore
effectively permanent. So publish **after** the CLI actually runs on a real file, never
to "reserve the name".

Before the first publish:

- [ ] `pnpm verify` green, and `bash scripts/check-fresh-clone.sh` green — the second one
      is what catches a file that works only because it was never committed.
- [ ] `pnpm build` has run, so `packages/core/grammars/` is populated, and
      `pnpm generate:third-party` leaves `THIRD-PARTY.md` unchanged.
- [ ] `npm pack --dry-run` in `packages/core`, and **read the file list**. It must contain
      `dist/`, all fifteen `grammars/*.wasm`, `README.md` and `THIRD-PARTY.md`. A tarball
      without the grammars still installs and still fails later, on someone else's
      machine, which is the failure shape this project is arranged against.
- [ ] `node dist/cli/bin.js --version` prints the version in the manifest, and
      `node dist/cli/bin.js <a real file> --budget 4000` prints text and a report.
- [ ] The version is deliberate. `0.0.0` is the placeholder; the first real publish picks
      a number and lives with it.

Files that carry the package name, should it ever need to change: `packages/core/package.json`,
`packages/core/README.md`, the root `README.md`, `CONTRIBUTING.md`, `docs/HANDOFF.md`. The
CLI's binary name is `smelt` and is independent of the package name — it is defined once,
as `CLI_NAME` in `src/cli/args.ts`.

## The recorded failure: watching the zero-network guard go red

The mutation suite mechanises this forever, but the guard was first proven by hand, the
way any new guard should be: break a real code path, run it, read what it says, put it
back. Here is that transcript, verbatim.

**The break.** Added to `packages/core/src/plan/lexical.ts` — a module the guard reaches
from the entrypoint, on the elision path itself:

```diff
+import { request } from 'node:https';
+
 export function planLexical(input: PlanInput, options: LexicalPlannerOptions = {}): ElisionPlan {
+  // DELIBERATE LAW 1 VIOLATION — added to watch the guard fail, then removed.
+  void request;
+  void fetch('https://example.invalid/rerank', { method: 'POST' });
   const lines = splitLines(input.text);
```

**What it printed:**

```
$ pnpm --filter @smeltjs/core exec vitest run test/guards/no-network.test.ts

 RUN  v4.1.11 /Users/…/smelt/packages/core

 ❯ test/guards/no-network.test.ts (7 tests | 2 failed) 12ms
     × imports no network transport, anywhere in the graph 4ms
     × never touches a network global 4ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/guards/no-network.test.ts > Law 1 — zero network > imports no network transport, anywhere in the graph
AssertionError: Law 1 violation: smelt v1 makes zero network calls: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "plan/lexical.ts → node:https: \"node:https\" is a network transport",
+ ]

 ❯ test/guards/no-network.test.ts:148:78

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  test/guards/no-network.test.ts > Law 1 — zero network > never touches a network global
AssertionError: Law 1 violation: network-capable global in the elision path: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "plan/lexical.ts references `fetch`",
+ ]

 ❯ test/guards/no-network.test.ts:172:87

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  1 failed (1)
      Tests  2 failed | 5 passed (7)
   Duration  150ms
```

Two independent assertions caught it — the import walk and the global scan — and both
named the offending file. **Then the change was reverted and the guard went green again**
(7 passed), which is the other half of the exercise: a check that fails on clean source
is just as useless as one that passes on broken source.

Note what the run _does not_ say: nothing about `example.invalid` being unreachable, no
DNS error, no timeout. The guard is static. It fails on the _capability_, not on the
call succeeding — because a network call that fails in CI and succeeds on a user's
laptop is the worst possible outcome.

## Style

- **Every elision needs a sentence.** If you cannot write `explanation` for a rule in
  plain words — "collapsed 3 sibling functions" — the rule does not ship. That sentence
  is what the model reads and what a human reads in a diff.
- **Determinism.** Same input, same plan. No timestamps, no `Math.random`, no map
  iteration order leaking into output. Planners are pure functions of their input.
- **Comments explain _why_.** What the code does is visible; why it is allowed to do it,
  and what happens if someone changes it, is not.
- Conventional Commits.
- Bytes, not characters. Budgets, ranges and counters are UTF-8 bytes. `'🔥'.length` is
  2; it costs 4. Budgets are bytes **permanently** — the reasoning, including why there is
  no local Claude tokenizer and why a token budget silently retunes itself between model
  generations, is in [`docs/HANDOFF.md` § "Decisions the founder has made"](docs/HANDOFF.md#decisions-the-founder-has-made).
  If you want a token count in the result, supply a `measure`; do not change the unit.
- **Never touch the marker format** without reading "Two promises, not one" above.

## Adding a language

1. Add the id to `LanguageId` in `src/types.ts`. `WASM_BY_LANGUAGE` in
   `src/plan/grammar.ts` is typed `Record<LanguageId, string>`, so this immediately fails
   to compile until you map its grammar — the two cannot drift.
2. Map the extensions in `src/detect.ts` and add the id to `SUPPORTED_LANGUAGES`.
3. `test/detect.test.ts` asserts a grammar resolves on disk for every language in
   `SUPPORTED_LANGUAGES`. It will fail until step 1 is real.
4. Add the language's node kinds to `STRUCTURE_BY_LANGUAGE` in
   `src/plan/structural.ts`, and a fixture proving a sibling collapse on it — the
   totality guard (`test/guards/structural-totality.test.ts`) fails until the
   fixture, snapshot and doc-comment case all exist.

## Opening a PR

Run `pnpm verify` first — it is the same gate CI runs. If you touched a user-facing
surface, say what you ran and what you saw; if you added a guard, paste the `pnpm mutate`
line showing it caught its mutation. "Tests pass" is not evidence that a _new_ check
works.
