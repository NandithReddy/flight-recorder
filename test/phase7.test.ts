/**
 * Phase 7 exit criteria, as executable tests.
 *
 * The bar is "point the harness at an agent this project did not write". The
 * agent loop under test here is LangGraph's prebuilt ReAct agent; the bridge is
 * the only new harness code, and the bridge is where a silent inversion would
 * live — a role mapped wrongly, a tool-call id dropped, an args object
 * stringified. Every conversion is therefore tested in both directions, and
 * the whole foreign loop runs against the deterministic mock so CI exercises
 * it with no model and no network.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

import { makeConfig } from "../src/core/ids.ts";
import { SqliteTraceStore } from "../src/store/sqlite-store.ts";
import { createMockClient } from "../src/provider/mock.ts";
import {
  ModelClientChatBridge,
  toBridgeMessage,
  toToolSpec,
} from "../src/provider/langchain-bridge.ts";
import { record, replay } from "../src/replay/replay.ts";
import { clearAgents, getAgent, registerAgent } from "../src/replay/registry.ts";
import { freeze } from "../src/freeze/freezer.ts";
import { evaluateAll } from "../src/freeze/assertions.ts";
import { reactAnalyst } from "../examples/react-analyst.ts";
import { DEMO_QUESTION, demoAgent } from "../examples/demo-agent.ts";
import type { GenerateRequest, ModelClient } from "../src/provider/types.ts";
import type { Trace } from "../src/core/types.ts";

let root: string;
let store: SqliteTraceStore;

const v1Config = makeConfig({
  provider: "mock",
  model: "demo-model",
  promptVersion: "v1",
  toolset: ["search", "calculate"],
});
const v0Config = makeConfig({
  provider: "mock",
  model: "demo-model",
  promptVersion: "v0",
  toolset: ["search", "calculate"],
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fr-p7-"));
  store = new SqliteTraceStore(root);
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

/** A client that records what the bridge sends it and replies scriptedly. */
function capturingClient(reply: () => { text: string; toolCalls?: { id: string; name: string; input: Record<string, unknown> }[] }) {
  const requests: GenerateRequest[] = [];
  const client: ModelClient = {
    providerId: "capture",
    async generate(request) {
      requests.push(request);
      const r = reply();
      return {
        text: r.text,
        toolCalls: r.toolCalls ?? [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        finishReason: r.toolCalls?.length ? "tool_use" : "stop",
      };
    },
  };
  return { client, requests };
}

// ---------------------------------------------------------------------------
// The bridge, outbound: LangChain messages → harness messages
// ---------------------------------------------------------------------------

describe("bridge outbound conversion", () => {
  it("maps every role the ReAct loop produces", () => {
    expect(toBridgeMessage(new SystemMessage("be brief"))).toEqual({
      role: "system",
      content: "be brief",
    });
    expect(toBridgeMessage(new HumanMessage("question"))).toEqual({
      role: "user",
      content: "question",
    });
    expect(
      toBridgeMessage(new ToolMessage({ content: "18.33", tool_call_id: "call_1", name: "calculate" })),
    ).toEqual({ role: "tool", content: "18.33", toolCallId: "call_1", toolName: "calculate" });
  });

  it("carries assistant tool calls with parsed args, not JSON strings", () => {
    const message = toBridgeMessage(
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call_9", name: "search", args: { query: "churn" } }],
      }),
    );

    expect(message.role).toBe("assistant");
    expect(message.toolCalls).toEqual([
      { id: "call_9", name: "search", input: { query: "churn" } },
    ]);
  });

  it("synthesises a deterministic id when LangChain omits one", () => {
    // Stubbed replay matches tool results to calls by id, so a random or
    // missing id would break replay silently.
    const message = toBridgeMessage(
      new AIMessage({ content: "", tool_calls: [{ name: "search", args: {} }] }),
    );
    expect(message.toolCalls?.[0]?.id).toBe("call_search_0");
  });

  it("refuses an unknown role rather than dropping it silently", () => {
    const impostor = new HumanMessage("x");
    Object.defineProperty(impostor, "type", { value: "function" });
    expect(() => toBridgeMessage(impostor)).toThrow(/cannot convert/);
  });
});

// ---------------------------------------------------------------------------
// The bridge, inbound: harness response → LangChain message
// ---------------------------------------------------------------------------

describe("bridge inbound conversion", () => {
  it("returns an AIMessage whose tool_calls LangGraph can route", async () => {
    const { client } = capturingClient(() => ({
      text: "checking",
      toolCalls: [{ id: "call_a", name: "search", input: { query: "arr" } }],
    }));

    const bridge = new ModelClientChatBridge({ client, model: "m" });
    const result = await bridge.invoke([new HumanMessage("q")]);

    expect(result.tool_calls).toEqual([
      expect.objectContaining({ id: "call_a", name: "search", args: { query: "arr" } }),
    ]);
    expect(result.text).toBe("checking");
  });

  it("hands bound tools to the client as ToolSpecs", async () => {
    const { client, requests } = capturingClient(() => ({ text: "done" }));
    const bridge = new ModelClientChatBridge({ client, model: "m" });

    const bound = bridge.bindTools([
      {
        type: "function",
        function: {
          name: "search",
          description: "look things up",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      },
    ]);
    await bound.invoke([new HumanMessage("q")]);

    expect(requests[0]?.tools).toEqual([
      {
        name: "search",
        description: "look things up",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);
  });

  it("passes the model id and temperature through unchanged", async () => {
    const { client, requests } = capturingClient(() => ({ text: "ok" }));
    const bridge = new ModelClientChatBridge({ client, model: "qwen2.5:7b", temperature: 0 });
    await bridge.invoke([new HumanMessage("q")]);

    expect(requests[0]?.model).toBe("qwen2.5:7b");
    expect(requests[0]?.temperature).toBe(0);
  });

  it("converts an OpenAI-style ToolDefinition to a ToolSpec", () => {
    expect(
      toToolSpec({
        type: "function",
        function: { name: "calc", parameters: { type: "object" } },
      }),
    ).toEqual({ name: "calc", description: "", inputSchema: { type: "object" } });
  });
});

// ---------------------------------------------------------------------------
// The foreign loop, end to end over the deterministic mock
// ---------------------------------------------------------------------------

describe("the ReAct agent on the harness", () => {
  const runReact = async (config = v1Config): Promise<Trace> =>
    (
      await record({
        agent: reactAnalyst,
        client: createMockClient(),
        config,
        input: DEMO_QUESTION,
        store,
      })
    ).trace;

  it("records the full loop: three model spans, two tool spans, in order", async () => {
    const trace = await runReact();

    expect(trace.error).toBeNull();
    expect(trace.spans.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "model:demo-model",
      "tool:search",
      "model:demo-model",
      "tool:calculate",
      "model:demo-model",
    ]);
    expect(String(trace.output)).toContain("18.33");
    expect(trace.totals.outputTokens).toBeGreaterThan(0);
  });

  it("degrades under the weak prompt exactly as the hand-rolled agent does", async () => {
    const trace = await runReact(v0Config);

    expect(trace.error).toBeNull();
    expect(trace.spans.filter((s) => s.name === "calculate")).toHaveLength(0);
    expect(String(trace.output)).toContain("roughly 25%");
  });

  it("supports stubbed replay without executing a single tool", async () => {
    const baseline = await runReact();

    // The world breaks. Stubbed replay must not notice.
    const result = await replay({
      traceId: baseline.id,
      agent: reactAnalyst,
      client: createMockClient(),
      config: v1Config,
      store,
      mode: "stubbed",
    });

    expect(result.stub?.identical).toBe(true);
    expect(result.candidate.output).toBe(baseline.output);
  });

  it("freezes into a case whose assertions catch the prompt regression", async () => {
    const good = await runReact();
    const { testCase } = freeze({ trace: good });
    const degraded = await runReact(v0Config);

    const results = evaluateAll(testCase.assertions, degraded);
    const hardFailures = results.filter((r) => !r.pass && r.assertion.hard);

    expect(hardFailures.map((r) => `${r.assertion.kind}:${r.assertion.value}`)).toContain(
      "tool_called:calculate",
    );
  });

  it("is resolvable from the registry by the name its cases will carry", () => {
    clearAgents();
    registerAgent(reactAnalyst);
    registerAgent(demoAgent);
    expect(getAgent("react-analyst")).toBe(reactAnalyst);
  });
});

// ---------------------------------------------------------------------------
// Findings from the adversarial review, pinned so they stay fixed
// ---------------------------------------------------------------------------

describe("stubbed replay serves recorded errors as errors", () => {
  /**
   * A client that scripts the recovery path LangGraph enables: ask for a bad
   * expression, see the error come back, retry with a good one, answer.
   */
  function recoveringClient(): ModelClient {
    return {
      providerId: "scripted",
      async generate(request) {
        const turn = request.messages.filter((m) => m.role === "assistant").length;
        const reply = (text: string, toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = []) => ({
          text,
          toolCalls,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          finishReason: (toolCalls.length ? "tool_use" : "stop") as "tool_use" | "stop",
        });

        if (turn === 0) return reply("", [{ id: "c1", name: "calculate", input: { expression: "abc" } }]);
        if (turn === 1) {
          // The model reads the error the environment produced and retries.
          const last = request.messages.at(-1);
          return reply(`saw <<${last?.content}>>`, [
            { id: "c2", name: "calculate", input: { expression: "1+1" } },
          ]);
        }
        const last = request.messages.at(-1);
        return reply(`final: ${last?.content}`);
      },
    };
  }

  it("reproduces a recovered tool error identically under stubbed replay", async () => {
    const { trace: baseline } = await record({
      agent: reactAnalyst,
      client: recoveringClient(),
      config: v1Config,
      input: "compute",
      store,
    });

    // The live run recovered: two calculate spans, the first errored, and the
    // model's own text quotes the error it saw.
    expect(baseline.error).toBeNull();
    const calcSpans = baseline.spans.filter((s) => s.name === "calculate");
    expect(calcSpans).toHaveLength(2);
    expect(calcSpans[0]?.error?.message).toContain("expected a number");
    expect(String(baseline.output)).toBe("final: 2.00");

    const result = await replay({
      traceId: baseline.id,
      agent: reactAnalyst,
      client: recoveringClient(),
      config: v1Config,
      store,
      mode: "stubbed",
    });

    // The candidate must have seen the SAME error text the live run saw — not
    // "null" — so the conversations stay byte-identical.
    expect(result.candidate.output).toBe(baseline.output);
    expect(result.stub?.identical).toBe(true);
    const replayed = result.candidate.spans.filter((s) => s.name === "calculate");
    expect(replayed[0]?.error?.message).toContain("expected a number");
  });

  it("rethrows a recorded failure for the hand-rolled agent too", async () => {
    // demoAgent has no recovery: a tool error aborts the run. Stubbed replay
    // must abort the same way, not hand back a successful null.
    const failing: Trace = {
      ...(
        await record({
          agent: demoAgent,
          client: createMockClient({ quality: "good" }),
          config: v1Config,
          input: DEMO_QUESTION,
          store,
        })
      ).trace,
    };
    const withError: Trace = {
      ...failing,
      id: "trace_err_baseline",
      spans: failing.spans.map((s, i) =>
        i === 1 ? { ...s, output: null, error: { message: "boom", type: "Error" } } : s,
      ),
    };
    await store.put(withError);

    const result = await replay({
      traceId: withError.id,
      agent: demoAgent,
      client: createMockClient({ quality: "good" }),
      config: v1Config,
      store,
      mode: "stubbed",
    });

    expect(result.candidate.error?.message).toBe("boom");
  });
});

describe("LangChain's schema validation boundary, pinned", () => {
  it("a schema-invalid call never executes, and behaves identically stubbed", async () => {
    // Turn 0 sends args zod rejects; turn 1 retries validly after seeing the
    // rejection; turn 2 answers.
    function invalidThenValid(): ModelClient {
      return {
        providerId: "scripted",
        async generate(request) {
          const turn = request.messages.filter((m) => m.role === "assistant").length;
          const reply = (text: string, toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = []) => ({
            text,
            toolCalls,
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
            finishReason: (toolCalls.length ? "tool_use" : "stop") as "tool_use" | "stop",
          });
          if (turn === 0) return reply("", [{ id: "b1", name: "search", input: { query: 42 as unknown as string } }]);
          if (turn === 1) return reply("", [{ id: "b2", name: "search", input: { query: "quarterly active users" } }]);
          return reply("done");
        },
      };
    }

    const { trace: baseline } = await record({
      agent: reactAnalyst,
      client: invalidThenValid(),
      config: v1Config,
      input: "q",
      store,
    });

    // The rejected call produced no tool span — LangChain refused it before
    // any user code. It is visible only in the following model span's request.
    expect(baseline.error).toBeNull();
    expect(baseline.spans.filter((s) => s.kind === "tool")).toHaveLength(1);

    // And because the rejection is deterministic and environment-free, the
    // stubbed replay is byte-identical: the held-still guarantee survives.
    const result = await replay({
      traceId: baseline.id,
      agent: reactAnalyst,
      client: invalidThenValid(),
      config: v1Config,
      store,
      mode: "stubbed",
    });
    expect(result.candidate.output).toBe(baseline.output);
    expect(result.stub?.identical).toBe(true);
  });
});

describe("the temperature axis is alive", () => {
  const tempConfig = makeConfig({
    provider: "mock",
    model: "demo-model",
    promptVersion: "v1",
    toolset: ["search", "calculate"],
    temperature: 0.7,
  });

  it.each([
    ["react-analyst", reactAnalyst],
    ["metrics-analyst", demoAgent],
  ])("%s sends the config's temperature, not a hardcoded one", async (_name, agent) => {
    const temperatures: (number | undefined)[] = [];
    const client: ModelClient = {
      providerId: "capture",
      async generate(request) {
        temperatures.push(request.temperature);
        // Answer immediately so the loop ends after one call.
        return {
          text: "done",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          finishReason: "stop",
        };
      },
    };

    await record({ agent, client, config: tempConfig, input: DEMO_QUESTION });
    expect(temperatures.every((t) => t === 0.7)).toBe(true);
    expect(temperatures.length).toBeGreaterThan(0);
  });
});
