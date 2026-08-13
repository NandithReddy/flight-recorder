/**
 * An orchestrator that delegates to a sub-agent.
 *
 * This exists to prove span nesting under conditions that break naive
 * implementations:
 *
 *   1. A sub-agent's model calls must nest under the delegating tool span, not
 *      sit beside it at the root.
 *   2. Two tools running concurrently at the root must both parent to the root,
 *      not to each other. A recorder that tracks "the current span" on a mutable
 *      stack gets this wrong, and gets it wrong intermittently, which is worse.
 */

import type { AgentContext, RecordableAgent } from "../src/replay/replay.ts";
import type { SpanScope } from "../src/recorder/recorder.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fastLookup(input: { key: string }): Promise<string> {
  await sleep(1);
  return `fast:${input.key}`;
}

async function slowLookup(input: { key: string }): Promise<string> {
  await sleep(12);
  return `slow:${input.key}`;
}

/** Runs entirely inside the caller's scope, so its spans nest under it. */
async function researchSubAgent(
  scope: SpanScope,
  client: AgentContext["client"],
  model: string,
  topic: string,
) {
  const scoped = scope.wrapModel(client);
  const readSource = scope.wrapTool("read_source", async (input: { url: string }) => {
    await sleep(2);
    return `contents of ${input.url}`;
  });

  const plan = await scoped.generate({
    model,
    messages: [{ role: "user", content: `Plan research on ${topic}` }],
  });

  await readSource({ url: "https://example.invalid/doc" });

  const summary = await scoped.generate({
    model,
    messages: [{ role: "user", content: `Summarise: ${plan.text}` }],
  });

  return summary.text;
}

export const nestedAgent: RecordableAgent<string, string> = {
  ref: { name: "orchestrator", version: "0.1.0" },

  async run(topic: string, ctx: AgentContext): Promise<string> {
    const client = ctx.recorder.wrapModel(ctx.client);
    const model = ctx.model;

    // Root-level model call.
    await client.generate({
      model,
      messages: [{ role: "user", content: topic }],
    });

    // Two tools in flight at once, both children of the root.
    const fast = ctx.recorder.wrapTool("fast_lookup", fastLookup);
    const slow = ctx.recorder.wrapTool("slow_lookup", slowLookup);
    await Promise.all([slow({ key: topic }), fast({ key: topic })]);

    // Delegation: everything the sub-agent does belongs under this span.
    const delegation = ctx.recorder.startSpan({
      kind: "tool",
      name: "delegate",
      input: { topic },
    });
    const findings = await researchSubAgent(delegation.scope, ctx.client, model, topic);
    delegation.end({ output: findings });

    return findings;
  },
};
