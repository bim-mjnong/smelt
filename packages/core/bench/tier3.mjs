/**
 * TIER 3 — expansion rate, measured by real model calls.
 *
 * This module is the paid network path. `run.mjs` loads it dynamically and only when
 * the caller passed `--tier3` *and* `ANTHROPIC_API_KEY` is present — it is never run
 * incidentally, because every call here costs money. Per HANDOFF Decision 8 the
 * founder runs it once and commits the retrieval log (`bench/tier3-log/<case>.json`),
 * so the rate is verifiable from a committed file rather than from trust.
 *
 * The measurement: the model is handed the smelted text, the case's task, and the
 * `smelt_retrieve` tool, and asked to do the task. Every `smelt_retrieve` invocation
 * is served from the real store and counted by the store's own counters — the same
 * counters the library ships, not a parallel tally. A case where the model retrieved
 * every elision back is a LOSS, reported as such with its input: the elision saved
 * nothing and cost a round trip.
 *
 * Like tier 2, this is the harness's own network call, outside the library. Nothing
 * under `src/` can reach this file.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_ROUNDS = 16;

/**
 * Runs one case against a real model and returns its retrieval log.
 *
 * `smelter` is a live Smelter whose store already holds the case's elisions;
 * `smeltedText` is the result text the model sees. The returned log carries every
 * request/response round and the store's final counters.
 */
export async function measureExpansion({ apiKey, model, benchCase, smelter, smeltedText }) {
  const tool = smelter.tool;
  const tools = [
    {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    },
  ];
  const messages = [
    {
      role: 'user',
      content:
        `${benchCase.task}.\n\n` +
        `The content below was shrunk by smelt; elided regions are markers you can ` +
        `expand with the ${tool.name} tool if — and only if — the task needs them.\n\n` +
        `${smeltedText}`,
    },
  ];
  const rounds = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const response = await request({ apiKey, model, tools, messages });
    rounds.push({ round, stop_reason: response.stop_reason, content: response.content });

    if (response.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      results.push(invokeTool(tool, block));
    }
    messages.push({ role: 'user', content: results });
  }

  const stats = smelter.stats();
  return {
    format: 'smelt-bench-tier3-log/v1',
    case: benchCase.id,
    model,
    rounds,
    stats: {
      elisionsStored: stats.elisionsStored,
      retrieveCalls: stats.retrieveCalls,
      uniqueRetrieved: stats.uniqueRetrieved,
      misses: stats.misses,
      expansionRate: stats.expansionRate,
      allElisionsRetrieved: stats.allElisionsRetrieved,
    },
  };
}

/** One tool invocation, surfaced to the model as a tool error on an unknown hash. */
function invokeTool(tool, block) {
  try {
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: tool.invoke({ hash: String(block.input?.hash ?? '') }),
    };
  } catch (error) {
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: error instanceof Error ? error.message : String(error),
      is_error: true,
    };
  }
}

async function request({ apiKey, model, tools, messages }) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({ model, max_tokens: 4096, tools, messages }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`messages: HTTP ${String(response.status)} — ${body}`);
  }
  return response.json();
}
