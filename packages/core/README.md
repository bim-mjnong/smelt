# @smeltjs/core

Structure-aware, reversible context optimization for coding agents. Zero network calls.

This is the library package. The project README, the four laws and their reasoning, the
build plan and the consumer contract all live in the repository root:
**https://github.com/mong-x/smelt**

```ts
import { createSmelter } from '@smeltjs/core';

const smelter = createSmelter({ defaultBudgetBytes: 8_000 });

const result = await smelter.smelt(toolOutput, {
  path: 'src/server.ts',
  focus: ['handleRequest'],
  budgetBytes: 4_000,
});

result.text; // send this to the model
smelter.tool; // the `smelt_retrieve` tool that gives it the rest back
smelter.stats().expansionRate; // whether you cut too much
```

There is also a CLI, installed as `smelt`:

```sh
smelt src/server.ts --budget 4000 --focus handleRequest   # text on stdout, report on stderr
smelt --budget 4000 --focus TypeError < build.log
smelt --reconstruct result.json                            # the round trip, from a shell
```

**Budgets are UTF-8 bytes, permanently** — the only unit computable locally for every
model, which is what makes the zero-network guarantee possible. Pass a `measure` if you
want a token count in the result as well; the budget stays bytes.

**Two stability promises.** The marker format (`<<smelt/v1: … >>`) and the
`smelt_retrieve` tool name are stable from 0.1 and treated as 1.0, because markers go into
prompts and a silent change to one shows up as worse model output with no error anywhere.
The TypeScript API is `0.x` and may move.

The parsers ship inside this tarball — no native build step, no post-install download.
That makes smelt a redistributor, so [`THIRD-PARTY.md`](./THIRD-PARTY.md) carries the
licences, generated from package metadata rather than written by hand.

**Pre-alpha.** The pipeline, the lexical planner and the CLI are real and tested. The
structural planner throws `NotImplementedError` — deliberately, rather than falling back to
something plausible. See [`docs/HANDOFF.md`](https://github.com/mong-x/smelt/blob/main/docs/HANDOFF.md).

Apache-2.0.
