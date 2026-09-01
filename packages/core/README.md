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

**Pre-alpha.** The pipeline and the lexical planner are real and tested. The structural
planner throws `NotImplementedError` — deliberately, rather than falling back to something
plausible. See [`docs/HANDOFF.md`](https://github.com/mong-x/smelt/blob/main/docs/HANDOFF.md).

Apache-2.0.
