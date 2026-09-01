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
| `pnpm build`                        | `tsc` per package into `dist/`                                         |
| `pnpm test`                         | vitest, all packages                                                   |
| `pnpm typecheck`                    | `tsc --noEmit`, including tests                                        |
| `pnpm lint`                         | oxlint, warnings are errors                                            |
| `pnpm format` / `pnpm format:check` | prettier                                                               |
| `pnpm mutate`                       | the mutation suite — see below                                         |
| `bash scripts/check-fresh-clone.sh` | installs and verifies from `git archive` output (tracked files only)   |

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
plan(_input: PlanInput): Promise<ElisionPlan> {
  throw new NotImplementedError('the structural planner', 'docs/HANDOFF.md § "Slice 2"');
}
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

=== mutations: every guard must go red ===

  CAUGHT  law1-node-https-import
           mutation: a network transport imported directly into the elision path
           guard:    test/guards/no-network.test.ts
           red on:   AssertionError: Law 1 violation: smelt v1 makes zero network calls: expected [ Array(1) ] to deeply equal []
  …
=== 7/7 mutations caught across 3 guards ===
```

**Adding a guard? The convention is three steps:**

1. Import the library through `@guard/…` rather than a relative path, so the alias in
   `packages/core/vitest.config.ts` can be redirected at a broken copy.
2. Add an entry to `MUTATIONS` in `scripts/mutate.mjs`: the guard it must break, the
   exact source string to change, and _why that break matters_.
3. Run `pnpm mutate`. If the guard survives, the guard is wrong — fix the guard, not the
   mutation.

The `find` anchor must match **exactly once**. A mutation that silently no-ops because
the source moved is the same class of bug the guards exist to catch, so it is a hard
error rather than a warning.

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
  2; it costs 4.

## Adding a language

1. Add the id to `LanguageId` in `src/types.ts`. `WASM_BY_LANGUAGE` in
   `src/plan/grammar.ts` is typed `Record<LanguageId, string>`, so this immediately fails
   to compile until you map its grammar — the two cannot drift.
2. Map the extensions in `src/detect.ts` and add the id to `SUPPORTED_LANGUAGES`.
3. `test/detect.test.ts` asserts a grammar resolves on disk for every language in
   `SUPPORTED_LANGUAGES`. It will fail until step 1 is real.
4. Add the language's node kinds to the structural planner's query set (once Slice 2
   exists) and a fixture proving a sibling collapse on it.

## Opening a PR

Run `pnpm verify` first — it is the same gate CI runs. If you touched a user-facing
surface, say what you ran and what you saw; if you added a guard, paste the `pnpm mutate`
line showing it caught its mutation. "Tests pass" is not evidence that a _new_ check
works.
