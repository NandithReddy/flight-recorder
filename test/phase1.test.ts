/**
 * Phase 1 exit criteria, as executable tests.
 *
 * The bar is "a real agent run produces a complete, replayable trace": spans
 * carry OpenTelemetry GenAI attributes, nesting survives concurrency, secrets
 * never reach the trace, sampling keeps what matters, and cost is real.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { makeConfig } from "../src/core/ids.ts";
import { Recorder } from "../src/recorder/recorder.ts";
import { createRedactor, DEFAULT_RULES } from "../src/recorder/redact.ts";
import { bucketOf, createSampler } from "../src/recorder/sampling.ts";
import { canonicalModelId, costOf, priceFor } from "../src/provider/pricing.ts";
import {
  createGatewayClient,
  hasGatewayCredential,
  MissingGatewayCredentialError,
} from "../src/provider/ai-gateway.ts";
import { captureTracing, type CapturedTracing } from "../src/otel/testing.ts";
import { FR, GenAI } from "../src/otel/conventions.ts";
import { createMockClient } from "../src/provider/mock.ts";
import { record } from "../src/replay/replay.ts";
import { nestedAgent } from "../examples/nested-agent.ts";
import { DEMO_QUESTION, demoAgent } from "../examples/demo-agent.ts";
import type { Trace } from "../src/core/types.ts";

const config = makeConfig({
  provider: "mock",
  model: "demo-model",
  promptVersion: "v1",
  toolset: ["search", "calculate"],
  temperature: 0,
});

let tracing: CapturedTracing | null = null;

afterEach(async () => {
  await tracing?.shutdown();
  tracing = null;
});

/** OTel renamed this field across versions; accept either spelling. */
function parentSpanIdOf(span: ReadableSpan): string | undefined {
  const withNew = span as unknown as { parentSpanContext?: { spanId?: string } };
  const withOld = span as unknown as { parentSpanId?: string };
  return withNew.parentSpanContext?.spanId ?? withOld.parentSpanId;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe("redaction", () => {
  const redact = createRedactor();

  it("scrubs provider credentials out of free text", () => {
    const input = {
      note: "call with sk-ant-api03-AAAABBBBCCCCDDDD then ghp_abcdefghijklmnopqrst",
      header: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      aws: "AKIAIOSFODNN7EXAMPLE",
    };
    const out = JSON.stringify(redact(input));

    expect(out).not.toContain("sk-ant-api03");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrst");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[redacted:anthropic-key]");
    expect(out).toContain("[redacted:github-token]");
    // The scheme survives so the shape of the request stays legible.
    expect(out).toContain("Bearer [redacted]");
  });

  it("redacts by key name for secrets that match no pattern", () => {
    const out = redact({ password: "hunter2", apiKey: "plain", nested: { authToken: "x" } });
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).not.toContain("plain");
  });

  it("preserves structure and non-secret values", () => {
    const input = { steps: 3, ok: true, items: ["a", "b"], nested: { n: null } };
    expect(redact(input)).toEqual(input);
  });

  it("survives circular references instead of hanging", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    expect(JSON.stringify(redact(cyclic))).toContain("[circular]");
  });

  it("is repeatable — global regexes do not carry lastIndex between calls", () => {
    const value = { a: "sk-ant-api03-AAAABBBBCCCCDDDD", b: "sk-ant-api03-AAAABBBBCCCCDDDD" };
    const first = JSON.stringify(redact(value));
    const second = JSON.stringify(redact(value));
    expect(first).toBe(second);
    expect(first).not.toContain("sk-ant");
    // Both occurrences, not just the first.
    expect(DEFAULT_RULES.length).toBeGreaterThan(0);
  });

  it("only redacts card-like numbers when opted in, and only valid ones", () => {
    const on = createRedactor({ redactLuhn: true });
    // 4242424242424242 is a valid Luhn; 1234567890123456 is not.
    expect(JSON.stringify(on({ v: "4242 4242 4242 4242" }))).toContain("[redacted:card]");
    expect(JSON.stringify(on({ v: "1234567890123456" }))).toContain("1234567890123456");
    expect(JSON.stringify(redact({ v: "4242424242424242" }))).toContain("4242424242424242");
  });
});

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

describe("sampling", () => {
  const traceWith = (over: Partial<Trace>): Trace =>
    ({
      id: "trace_sample_fixture",
      error: null,
      tags: [],
      totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0, steps: 0 },
      ...over,
    }) as Trace;

  it("keeps every errored run regardless of rate", () => {
    const sampler = createSampler({ rate: 0 });
    const decision = sampler(traceWith({ error: { message: "boom" } }));
    expect(decision).toEqual({ keep: true, reason: "error" });
  });

  it("keeps flagged runs regardless of rate", () => {
    const sampler = createSampler({ rate: 0 });
    expect(sampler(traceWith({ tags: ["flagged"] })).reason).toBe("tagged");
  });

  it("keeps cost outliers", () => {
    const sampler = createSampler({ rate: 0, alwaysKeepAboveCostUsd: 1 });
    const expensive = traceWith({
      totals: { inputTokens: 0, outputTokens: 0, costUsd: 5, wallMs: 0, steps: 0 },
    });
    expect(sampler(expensive).reason).toBe("cost-outlier");
  });

  it("is deterministic — the same trace is always kept or always dropped", () => {
    const sampler = createSampler({ rate: 0.5 });
    const t = traceWith({});
    const first = sampler(t).keep;
    for (let i = 0; i < 20; i += 1) expect(sampler(t).keep).toBe(first);
  });

  it("approximates the configured rate across many ids", () => {
    const sampler = createSampler({ rate: 0.25 });
    let kept = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) {
      if (sampler(traceWith({ id: `trace_${i}` })).keep) kept += 1;
    }
    expect(kept / n).toBeGreaterThan(0.22);
    expect(kept / n).toBeLessThan(0.28);
  });

  it("maps ids into [0, 1)", () => {
    for (const id of ["a", "b", "trace_x", ""]) {
      const bucket = bucketOf(id);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe("pricing", () => {
  it("normalises gateway ids to the canonical form", () => {
    expect(canonicalModelId("anthropic/claude-opus-4.8")).toBe("claude-opus-4-8");
    expect(canonicalModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(canonicalModelId("anthropic/claude-opus-5")).toBe("claude-opus-5");
  });

  it("prices a gateway model exactly as its first-party twin", () => {
    const viaGateway = costOf({
      model: "anthropic/claude-opus-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const direct = costOf({
      model: "claude-opus-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(viaGateway.costUsd).toBe(direct.costUsd);
    expect(direct.costUsd).toBeCloseTo(30, 6); // $5 in + $25 out
  });

  it("honours promotional pricing only while it is in effect", () => {
    const during = priceFor("claude-sonnet-5", new Date("2026-08-13"));
    const after = priceFor("claude-sonnet-5", new Date("2026-09-01"));
    expect(during.intro).toBe(true);
    expect(during.inputPerMTok).toBe(2);
    expect(after.intro).toBe(false);
    expect(after.inputPerMTok).toBe(3);
  });

  it("charges cache reads at a tenth and writes at a premium", () => {
    const base = costOf({ model: "claude-opus-5", inputTokens: 1_000_000, outputTokens: 0 });
    const read = costOf({
      model: "claude-opus-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    const write = costOf({
      model: "claude-opus-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
    });
    expect(read.costUsd).toBeCloseTo(base.costUsd * 0.1, 6);
    expect(write.costUsd).toBeCloseTo(base.costUsd * 1.25, 6);
  });

  it("flags an unpriced model instead of reporting a free run", () => {
    const result = costOf({ model: "some-unreleased-model", inputTokens: 1000, outputTokens: 1000 });
    expect(result.unknown).toBe(true);
    expect(result.costUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sampling, wired into the record path
// ---------------------------------------------------------------------------

describe("sampling in the record path", () => {
  it("returns the trace in full even when the policy drops it", async () => {
    const stored: Trace[] = [];
    const store = {
      put: async (trace: Trace) => {
        stored.push(trace);
        return { id: trace.id, sha: "x", deduped: false };
      },
      get: async () => null,
      list: async () => [],
      stats: async () => ({ traces: 0, blobs: 0, bytes: 0 }),
    };

    const trace = await record({
      agent: demoAgent,
      client: createMockClient(),
      config,
      input: DEMO_QUESTION,
      store,
      sampler: () => ({ keep: false, reason: "sampled-out" as const }),
    });

    // Captured and returned to the caller...
    expect(trace.spans.length).toBe(5);
    expect(trace.sampling?.keep).toBe(false);
    // ...but never persisted.
    expect(stored.length).toBe(0);
  });

  it("persists a run the policy keeps", async () => {
    const stored: Trace[] = [];
    const store = {
      put: async (trace: Trace) => {
        stored.push(trace);
        return { id: trace.id, sha: "x", deduped: false };
      },
      get: async () => null,
      list: async () => [],
      stats: async () => ({ traces: 0, blobs: 0, bytes: 0 }),
    };

    await record({
      agent: demoAgent,
      client: createMockClient(),
      config,
      input: DEMO_QUESTION,
      store,
      sampler: createSampler({ rate: 1 }),
    });

    expect(stored.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Gateway adapter
// ---------------------------------------------------------------------------

describe("gateway adapter", () => {
  it("fails with an actionable message when no credential is available", async () => {
    const saved = {
      key: process.env.AI_GATEWAY_API_KEY,
      oidc: process.env.VERCEL_OIDC_TOKEN,
    };
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;

    try {
      const client = createGatewayClient();
      await expect(
        client.generate({
          model: "anthropic/claude-opus-5",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow(MissingGatewayCredentialError);
      expect(hasGatewayCredential()).toBe(false);
    } finally {
      if (saved.key !== undefined) process.env.AI_GATEWAY_API_KEY = saved.key;
      if (saved.oidc !== undefined) process.env.VERCEL_OIDC_TOKEN = saved.oidc;
    }
  });
});

// ---------------------------------------------------------------------------
// OpenTelemetry emission
// ---------------------------------------------------------------------------

describe("otel emission", () => {
  it("emits GenAI-conventional spans for model and tool calls", async () => {
    tracing = captureTracing();
    const recorder = new Recorder({
      agent: demoAgent.ref,
      config,
      tracer: tracing.tracer,
    });

    const client = recorder.wrapModel(createMockClient({ quality: "good" }));
    await client.generate({
      model: "demo-model",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 512,
    });
    await recorder.wrapTool("search", (input: { q: string }) => `hit:${input.q}`)({ q: "x" });
    recorder.finish({ input: null, output: null });

    const spans = tracing.spans();
    expect(spans.length).toBe(2);

    const modelSpan = spans.find((s) => s.name.startsWith("chat "));
    expect(modelSpan?.name).toBe("chat demo-model");
    expect(modelSpan?.attributes[GenAI.SYSTEM]).toBe("mock");
    expect(modelSpan?.attributes[GenAI.OPERATION_NAME]).toBe("chat");
    expect(modelSpan?.attributes[GenAI.REQUEST_MODEL]).toBe("demo-model");
    expect(modelSpan?.attributes[GenAI.REQUEST_MAX_TOKENS]).toBe(512);
    expect(modelSpan?.attributes[GenAI.USAGE_INPUT_TOKENS]).toBeGreaterThan(0);
    expect(modelSpan?.attributes[GenAI.USAGE_OUTPUT_TOKENS]).toBeGreaterThan(0);
    expect(modelSpan?.attributes[FR.CONFIG_ID]).toBe(config.id);

    const toolSpan = spans.find((s) => s.name.startsWith("execute_tool "));
    expect(toolSpan?.name).toBe("execute_tool search");
    expect(toolSpan?.attributes[GenAI.TOOL_NAME]).toBe("search");
  });

  it("marks a failed span as an error", async () => {
    tracing = captureTracing();
    const recorder = new Recorder({ agent: demoAgent.ref, config, tracer: tracing.tracer });
    const failing = recorder.wrapTool("explode", () => {
      throw new Error("nope");
    });

    await expect(failing({})).rejects.toThrow("nope");
    recorder.finish({ input: null, output: null });

    expect(tracing.spans()[0]?.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it("is a no-op when no tracer is registered", async () => {
    // Constructed without a tracer: the global API returns a noop, so this must
    // still record a complete Trace without throwing.
    const trace = await record({
      agent: demoAgent,
      client: createMockClient(),
      config,
      input: DEMO_QUESTION,
    });
    expect(trace.spans.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Nesting — the part naive recorders get wrong
// ---------------------------------------------------------------------------

describe("span nesting", () => {
  it("nests a sub-agent's spans under the delegating span", async () => {
    const trace = await record({
      agent: nestedAgent,
      client: createMockClient(),
      config,
      input: "quarterly growth",
    });

    const byName = (name: string) => trace.spans.filter((s) => s.name === name);
    const delegate = byName("delegate")[0];
    expect(delegate).toBeDefined();
    expect(delegate?.parentId).toBeNull();

    const readSource = byName("read_source")[0];
    expect(readSource?.parentId).toBe(delegate?.id);

    // The sub-agent made two model calls; both belong to the delegation.
    const delegatedModelSpans = trace.spans.filter(
      (s) => s.kind === "model" && s.parentId === delegate?.id,
    );
    expect(delegatedModelSpans.length).toBe(2);
  });

  it("parents concurrent tool calls to the root, not to each other", async () => {
    const trace = await record({
      agent: nestedAgent,
      client: createMockClient(),
      config,
      input: "quarterly growth",
    });

    const fast = trace.spans.find((s) => s.name === "fast_lookup");
    const slow = trace.spans.find((s) => s.name === "slow_lookup");

    // slow_lookup starts first and finishes last, so a stack-based recorder
    // would hand fast_lookup the wrong parent.
    expect(slow?.startedAt).toBeLessThanOrEqual(fast?.startedAt ?? 0);
    expect(slow?.endedAt).toBeGreaterThan(fast?.endedAt ?? 0);
    expect(fast?.parentId).toBeNull();
    expect(slow?.parentId).toBeNull();
  });

  it("mirrors the same parentage into the OTel spans", async () => {
    tracing = captureTracing();
    const recorder = new Recorder({ agent: nestedAgent.ref, config, tracer: tracing.tracer });

    const parent = recorder.startSpan({ kind: "tool", name: "delegate", input: {} });
    await parent.scope.wrapTool("child", () => "ok")({});
    parent.end({ output: "done" });
    recorder.finish({ input: null, output: null });

    const spans = tracing.spans();
    const child = spans.find((s) => s.name === "execute_tool child");
    const delegate = spans.find((s) => s.name === "execute_tool delegate");

    expect(child && delegate).toBeTruthy();
    expect(parentSpanIdOf(child!)).toBe(delegate!.spanContext().spanId);
    expect(parentSpanIdOf(delegate!)).toBeUndefined();
  });

  it("re-scopes an already-wrapped client instead of double-counting it", async () => {
    const recorder = new Recorder({ agent: nestedAgent.ref, config });
    const once = recorder.wrapModel(createMockClient());
    const twice = recorder.wrapModel(once);

    await twice.generate({ model: "demo-model", messages: [{ role: "user", content: "hi" }] });
    const trace = recorder.finish({ input: null, output: null });

    // One call, one span — not two, and the totals are counted once.
    expect(trace.spans.length).toBe(1);
    expect(trace.totals.outputTokens).toBe(trace.spans[0]?.usage?.outputTokens);
  });

  it("keeps every span in the trace regardless of nesting depth", async () => {
    const trace = await record({
      agent: nestedAgent,
      client: createMockClient(),
      config,
      input: "quarterly growth",
    });

    // 1 root model + 2 concurrent tools + delegate + (2 model + 1 tool) nested.
    expect(trace.spans.length).toBe(7);
    expect(trace.totals.steps).toBe(7);
    expect(trace.error).toBeNull();
    expect(trace.spans.every((s) => s.endedAt >= s.startedAt)).toBe(true);
  });
});
