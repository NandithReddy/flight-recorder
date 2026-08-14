/**
 * The same analyst task, running on an agent loop this project did not write.
 *
 * The loop is LangGraph's prebuilt ReAct agent — the most widely deployed
 * open-source agent loop in the JS ecosystem. It decides when to call tools,
 * how to route their results, when to stop, and how to recover from a tool
 * error. None of that logic is ours, which is the point: phase 7's claim is
 * that the harness records and regresses an agent it has no say in.
 *
 * What IS ours: the two domain tools and the prompt variants — deliberately
 * identical to the demo agent's, so a comparison between the two agents is a
 * comparison of loops, not of tasks.
 *
 * Two boundaries worth knowing before reading traces, both properties of the
 * agent under test rather than of the harness:
 *
 *   - Our hand-rolled loop lets a tool error abort the run (`trace.error`),
 *     while LangGraph's ToolNode catches it and hands the error text back to
 *     the model to retry. Neither is wrong; the tool-error span is recorded
 *     either way.
 *   - LangChain validates tool arguments against the schema BEFORE any user
 *     code runs, so a schema-invalid call the model makes never executes and
 *     never becomes a tool span — it is visible only as the rejection message
 *     inside the next model span's request. The hand-rolled agent passes raw
 *     arguments through, so the same model behaviour IS a recorded span there.
 *     This cannot be papered over in-process (verified against core 1.2.7:
 *     zod and JSON-schema tools both throw ToolInputParsingException before
 *     the handler), and it is deterministic and environment-free, so it is
 *     identical in live and stubbed modes — the held-still guarantee survives.
 */

import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { ModelClientChatBridge } from "../src/provider/langchain-bridge.ts";
import type { RecordableAgent } from "../src/replay/replay.ts";
import { calculate, PROMPTS, search } from "./demo-agent.ts";

const MAX_GRAPH_STEPS = 25;

export const reactAnalyst: RecordableAgent<string, string> = {
  ref: { name: "react-analyst", version: "1.0.0" },

  async run(question: string, ctx): Promise<string> {
    // Wrapped through the recorder, so tool spans land in the trace and
    // stubbed replay's interceptor applies to this agent unchanged.
    const wrappedSearch = ctx.recorder.wrapTool("search", search);
    const wrappedCalculate = ctx.recorder.wrapTool("calculate", calculate);

    const tools = [
      tool(async (args: { query: string }) => wrappedSearch(args), {
        name: "search",
        description: "Look up a metric in the company knowledge base.",
        schema: z.object({ query: z.string() }),
      }),
      tool(async (args: { expression: string }) => wrappedCalculate(args), {
        name: "calculate",
        description: "Evaluate an arithmetic expression.",
        schema: z.object({ expression: z.string() }),
      }),
    ];

    const agent = createReactAgent({
      llm: new ModelClientChatBridge({
        client: ctx.client,
        model: ctx.model,
        ...(ctx.temperature !== undefined ? { temperature: ctx.temperature } : {}),
      }),
      tools,
      prompt: PROMPTS[ctx.promptVersion] ?? PROMPTS["v1"]!,
    });

    const result = await agent.invoke(
      { messages: [{ role: "user", content: question }] },
      { recursionLimit: MAX_GRAPH_STEPS },
    );

    const final = result.messages.at(-1);
    return final?.text ?? "";
  },
};
