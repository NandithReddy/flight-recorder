/**
 * Phase 0 exit criteria, as executable tests.
 *
 * The bar for this phase is "an end-to-end skeleton exists": a run can be
 * recorded, stored, retrieved and replayed. Nothing here scores anything —
 * that is phase 4.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configId, makeConfig, stableStringify } from "../src/core/ids.ts";
import { Recorder } from "../src/recorder/recorder.ts";
import { FsTraceStore } from "../src/store/fs-store.ts";
import { record, replay } from "../src/replay/replay.ts";
import { createMockClient } from "../src/provider/mock.ts";
import { DEMO_QUESTION, demoAgent } from "../examples/demo-agent.ts";

let root: string;
let store: FsTraceStore;

const goodConfig = makeConfig({
  provider: "mock",
  model: "demo-model",
  promptVersion: "v1",
  toolset: ["search", "calculate"],
  temperature: 0,
});

const degradedConfig = makeConfig({
  provider: "mock",
  model: "demo-model",
  promptVersion: "v2-degraded",
  toolset: ["search", "calculate"],
  temperature: 0,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fr-test-"));
  store = new FsTraceStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("stable identity", () => {
  it("hashes structurally equal values identically regardless of key order", () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(
      stableStringify({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("drops undefined so optional fields do not change identity", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it("changes the config id when a field that can change the answer changes", () => {
    const base = {
      provider: "mock",
      model: "demo-model",
      promptVersion: "v1",
      toolset: ["search"],
    };
    expect(configId(base)).toBe(configId({ ...base }));
    expect(configId(base)).not.toBe(configId({ ...base, promptVersion: "v2" }));
    expect(configId(base)).not.toBe(configId({ ...base, toolset: ["search", "calculate"] }));
  });
});

describe("recorder", () => {
  it("captures model and tool spans with usage and wall time", async () => {
    const { trace } = await record({
      agent: demoAgent,
      client: createMockClient({ quality: "good" }),
      config: goodConfig,
      input: DEMO_QUESTION,
    });

    const kinds = trace.spans.map((s) => s.kind);
    expect(kinds.filter((k) => k === "model").length).toBe(3);
    expect(kinds.filter((k) => k === "tool").length).toBe(2);

    expect(trace.error).toBeNull();
    expect(trace.totals.steps).toBe(trace.spans.length);
    expect(trace.totals.outputTokens).toBeGreaterThan(0);
    expect(trace.totals.costUsd).toBeGreaterThan(0);
    expect(trace.spans.every((s) => s.endedAt >= s.startedAt)).toBe(true);
  });

  it("records the error instead of throwing when the agent fails", async () => {
    const exploding = {
      ref: { name: "exploding", version: "0.0.0" },
      async run(): Promise<never> {
        throw new Error("tool backend unreachable");
      },
    };

    const { trace } = await record({
      agent: exploding,
      client: createMockClient(),
      config: goodConfig,
      input: "anything",
    });

    expect(trace.error?.message).toBe("tool backend unreachable");
    expect(trace.output).toBeNull();
  });

  it("closes spans the agent left open rather than writing a torn trace", () => {
    const recorder = new Recorder({ agent: { name: "t", version: "0" }, config: goodConfig });
    recorder.startSpan({ kind: "tool", name: "leaky", input: {} });
    const trace = recorder.finish({ input: null, output: null });

    expect(trace.spans[0]?.endedAt).toBeGreaterThan(0);
    expect(trace.spans[0]?.error?.type).toBe("TornSpan");
  });

  it("redacts on the way in, so secrets never reach the trace", async () => {
    const recorder = new Recorder({
      agent: { name: "t", version: "0" },
      config: goodConfig,
      redact: (value) => JSON.parse(JSON.stringify(value ?? null).replaceAll(/sk-[a-z0-9]+/g, "[redacted]")),
    });
    const span = recorder.startSpan({ kind: "tool", name: "auth", input: { key: "sk-abc123" } });
    span.end({ output: null });
    const trace = recorder.finish({ input: null, output: null });

    expect(JSON.stringify(trace)).not.toContain("sk-abc123");
    expect(JSON.stringify(trace)).toContain("[redacted]");
  });
});

describe("store", () => {
  it("round-trips a trace through content-addressed storage", async () => {
    const { trace } = await record({
      agent: demoAgent,
      client: createMockClient(),
      config: goodConfig,
      input: DEMO_QUESTION,
      store,
    });

    const loaded = await store.get(trace.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(trace.id);
    expect(loaded?.spans.length).toBe(trace.spans.length);
    expect(loaded?.output).toBe(trace.output);
  });

  it("stores one blob when the same trace is written twice", async () => {
    const { trace } = await record({
      agent: demoAgent,
      client: createMockClient(),
      config: goodConfig,
      input: DEMO_QUESTION,
    });

    const first = await store.put(trace);
    const second = await store.put(trace);

    expect(first.sha).toBe(second.sha);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect((await store.stats()).blobs).toBe(1);
    expect((await store.stats()).traces).toBe(1);
  });

  it("returns null for an unknown id rather than throwing", async () => {
    expect(await store.get("trace_nope")).toBeNull();
  });
});

describe("replay", () => {
  it("re-runs a stored trace's input and links the new trace to the old one", async () => {
    const { trace: baseline } = await record({
      agent: demoAgent,
      client: createMockClient({ quality: "good" }),
      config: goodConfig,
      input: DEMO_QUESTION,
      store,
    });

    const result = await replay({
      traceId: baseline.id,
      agent: demoAgent,
      client: createMockClient({ quality: "good" }),
      config: goodConfig,
      store,
    });

    expect(result.candidate.replayOf).toBe(baseline.id);
    expect(result.candidate.input).toBe(baseline.input);
    expect(result.candidate.output).toBe(baseline.output);
    expect((await store.list()).length).toBe(2);
  });

  it("surfaces a silent regression: the degraded config skips verification", async () => {
    const { trace: baseline } = await record({
      agent: demoAgent,
      client: createMockClient({ quality: "good" }),
      config: goodConfig,
      input: DEMO_QUESTION,
      store,
    });

    const { candidate } = await replay({
      traceId: baseline.id,
      agent: demoAgent,
      client: createMockClient({ quality: "degraded" }),
      config: degradedConfig,
      store,
    });

    const toolsIn = (t: typeof candidate) =>
      t.spans.filter((s) => s.kind === "tool").map((s) => s.name);

    // Nothing threw. Nothing errored. The answer is still fluent English.
    expect(candidate.error).toBeNull();
    expect(String(candidate.output)).toMatch(/grew/);

    // But it never verified the number, and the answer changed.
    expect(toolsIn(baseline)).toContain("calculate");
    expect(toolsIn(candidate)).not.toContain("calculate");
    expect(candidate.output).not.toBe(baseline.output);
    expect(candidate.totals.steps).toBeLessThan(baseline.totals.steps);
  });
});
