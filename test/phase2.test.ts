/**
 * Phase 2 exit criteria, as executable tests.
 *
 * The bar is "ten cases created from real traces in under twenty minutes",
 * which in test terms means: the store round-trips losslessly and dedupes, the
 * proposer writes assertions a human would have written, and those assertions
 * catch the regression they were meant to catch.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeConfig } from "../src/core/ids.ts";
import { SqliteTraceStore } from "../src/store/sqlite-store.ts";
import { FsTraceStore } from "../src/store/fs-store.ts";
import { record, replay } from "../src/replay/replay.ts";
import { createMockClient } from "../src/provider/mock.ts";
import { DEMO_QUESTION, demoAgent } from "../examples/demo-agent.ts";
import { analyzeOutput, evaluateAll, proposeAssertions } from "../src/freeze/assertions.ts";
import { freeze, InvalidProposalError } from "../src/freeze/freezer.ts";
import { formatSuite, SuiteStore } from "../src/freeze/suite.ts";
import type { Trace } from "../src/core/types.ts";
import type { TraceStore } from "../src/store/types.ts";

const goodConfig = makeConfig({
  provider: "mock",
  model: "demo-model",
  promptVersion: "v1",
  toolset: ["search", "calculate"],
});

const degradedConfig = makeConfig({
  provider: "mock",
  model: "demo-model",
  promptVersion: "v2-degraded",
  toolset: ["search", "calculate"],
});

let root: string;
let sqlite: SqliteTraceStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fr-p2-"));
  sqlite = new SqliteTraceStore(root);
});

afterEach(async () => {
  sqlite.close();
  await rm(root, { recursive: true, force: true });
});

const recordGood = async (store?: TraceStore) =>
  (
    await record({
      agent: demoAgent,
      client: createMockClient({ quality: "good" }),
      config: goodConfig,
      input: DEMO_QUESTION,
      store,
    })
  ).trace;

// ---------------------------------------------------------------------------
// Store contract — both implementations, one set of expectations
// ---------------------------------------------------------------------------

describe.each([
  ["SqliteTraceStore", (dir: string) => new SqliteTraceStore(dir) as TraceStore],
  ["FsTraceStore", (dir: string) => new FsTraceStore(dir) as TraceStore],
])("%s satisfies the TraceStore contract", (_name, make) => {
  it("round-trips a trace losslessly", async () => {
    const store = make(root);
    const trace = await recordGood(store);

    const loaded = await store.get(trace.id);
    expect(loaded).toEqual(trace);
  });

  it("returns null for an unknown id rather than throwing", async () => {
    expect(await make(root).get("trace_nope")).toBeNull();
  });

  it("reports a repeat write as deduped and does not duplicate the entry", async () => {
    const store = make(root);
    const trace = await recordGood();

    expect((await store.put(trace)).deduped).toBe(false);
    expect((await store.put(trace)).deduped).toBe(true);
    expect((await store.list()).length).toBe(1);
  });

  it("lists newest first and honours the limit", async () => {
    const store = make(root);
    for (let i = 0; i < 4; i += 1) await recordGood(store);

    const all = await store.list();
    expect(all.length).toBe(4);
    for (let i = 1; i < all.length; i += 1) {
      expect(all[i - 1]!.startedAt).toBeGreaterThanOrEqual(all[i]!.startedAt);
    }
    expect((await store.list({ limit: 2 })).length).toBe(2);
  });

  it("filters by agent", async () => {
    const store = make(root);
    await recordGood(store);
    expect((await store.list({ agent: "metrics-analyst" })).length).toBe(1);
    expect((await store.list({ agent: "nobody" })).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Payload deduplication
// ---------------------------------------------------------------------------

describe("payload deduplication", () => {
  it("stores a repeated subtree once however many traces contain it", async () => {
    for (let i = 0; i < 12; i += 1) await recordGood(sqlite);

    const stats = await sqlite.dedupeStats();
    // Twelve identical runs share their system prompt and tool schemas.
    expect(stats.references).toBeGreaterThan(stats.uniquePayloads * 5);
    expect(stats.storedBytes).toBeLessThan(stats.naiveBytes * 0.7);
  });

  it("rehydrates deeply nested extracted values exactly", async () => {
    const trace = await recordGood(sqlite);
    const loaded = await sqlite.get(trace.id);

    const modelSpan = loaded!.spans.find((s) => s.kind === "model")!;
    const request = modelSpan.input as { messages: { role: string }[]; tools: unknown[] };

    expect(request.messages[0]!.role).toBe("system");
    expect(request.tools).toHaveLength(2);
    expect(modelSpan.input).toEqual(
      trace.spans.find((s) => s.id === modelSpan.id)!.input,
    );
  });

  it("keeps small values inline rather than paying for a reference", async () => {
    const store = new SqliteTraceStore(join(root, "big.db"), {
      payloadThresholdBytes: 100_000,
    });
    const trace = await recordGood(store);
    expect((await store.dedupeStats()).uniquePayloads).toBe(0);
    expect(await store.get(trace.id)).toEqual(trace);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Output analysis
// ---------------------------------------------------------------------------

describe("output analysis", () => {
  it("separates claims a tool produced from claims the model made up", async () => {
    const good = await recordGood();
    const literals = analyzeOutput(good);

    const verified = literals.filter((l) => l.verifiedBy !== null).map((l) => l.value);
    expect(verified).toContain("18.33");
    expect(literals.find((l) => l.value === "18.33")?.verifiedBy).toBe("calculate");
  });

  it("marks the degraded run's headline number as unverified", async () => {
    const { trace } = await record({
      agent: demoAgent,
      client: createMockClient({ quality: "degraded" }),
      config: degradedConfig,
      input: DEMO_QUESTION,
    });

    const literals = analyzeOutput(trace);
    // "25" is the number it invented; nothing produced it.
    expect(literals.find((l) => l.value === "25")?.verifiedBy).toBeNull();
    expect(literals.every((l) => l.verifiedBy === null)).toBe(true);
  });

  it("does not manufacture verification by normalising digits", async () => {
    // "1.2" must not be treated as verified just because the tool output
    // contains "1,200,000" — that would invent a check the run never made.
    const good = await recordGood();
    const fabricated: Trace = { ...good, output: "Users reached 1.2M this quarter." };
    expect(analyzeOutput(fabricated).find((l) => l.value === "1.2")?.verifiedBy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Proposal and freezing
// ---------------------------------------------------------------------------

describe("assertion proposal", () => {
  it("proposes assertions that all hold on the trace they came from", async () => {
    const good = await recordGood();
    const proposals = proposeAssertions(good);

    const results = evaluateAll(
      proposals.map((p) => p.assertion),
      good,
    );
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it("pins the tools the run used and the facts those tools produced", async () => {
    const proposals = proposeAssertions(await recordGood());
    const kinds = proposals.map((p) => `${p.assertion.kind}:${p.assertion.value}`);

    expect(kinds).toContain("tool_called:search");
    expect(kinds).toContain("tool_called:calculate");
    expect(kinds).toContain("output_contains:18.33");
    expect(kinds).toContain("no_error:1");
  });

  it("makes behavioural assertions hard and noisy thresholds soft", async () => {
    const proposals = proposeAssertions(await recordGood());
    const byKind = new Map(proposals.map((p) => [p.assertion.kind, p.assertion]));

    expect(byKind.get("tool_called")?.hard).toBe(true);
    expect(byKind.get("output_contains")?.hard).toBe(true);
    expect(byKind.get("max_wall_ms")?.hard).toBe(false);
    expect(byKind.get("max_cost_usd")?.hard).toBe(false);
  });

  it("gives every proposal a rationale a reviewer can act on", async () => {
    for (const proposal of proposeAssertions(await recordGood())) {
      expect(proposal.rationale.length).toBeGreaterThan(30);
      expect(["high", "medium"]).toContain(proposal.confidence);
    }
  });

  it("refuses to freeze assertions that do not hold on the source trace", async () => {
    const good = await recordGood();
    expect(() =>
      freeze({
        trace: good,
        assertions: [
          { id: "a1", kind: "tool_called", value: "never_called", hard: true },
        ],
      }),
    ).toThrow(InvalidProposalError);
  });

  it("drops proposals by number", async () => {
    const good = await recordGood();
    const all = freeze({ trace: good });
    const fewer = freeze({ trace: good, drop: [2, 3] });

    expect(fewer.testCase.assertions.length).toBe(all.testCase.assertions.length - 2);
    expect(fewer.dropped.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The point of the whole phase
// ---------------------------------------------------------------------------

describe("a frozen case catches the regression", () => {
  it("fails on the degraded run while cost, steps and wall time all pass", async () => {
    const good = await recordGood(sqlite);
    const { testCase } = freeze({ trace: good });

    const { candidate } = await replay({
      traceId: good.id,
      agent: demoAgent,
      client: createMockClient({ quality: "degraded" }),
      config: degradedConfig,
      store: sqlite,
    });

    const results = evaluateAll(testCase.assertions, candidate);
    const failed = results.filter((r) => !r.pass);
    const hardFailures = failed.filter((r) => r.assertion.hard);

    expect(hardFailures.length).toBeGreaterThanOrEqual(2);
    expect(failed.map((r) => `${r.assertion.kind}:${r.assertion.value}`)).toContain(
      "tool_called:calculate",
    );
    expect(failed.map((r) => `${r.assertion.kind}:${r.assertion.value}`)).toContain(
      "output_contains:18.33",
    );

    // Every resource assertion passes, because the broken agent is cheaper and
    // faster than the correct one. Cost alone would have promoted it.
    const resourceKinds = ["max_steps", "max_cost_usd", "max_wall_ms"];
    for (const result of results.filter((r) => resourceKinds.includes(r.assertion.kind))) {
      expect(result.pass).toBe(true);
    }
    expect(candidate.totals.costUsd).toBeLessThan(good.totals.costUsd);
  });
});

// ---------------------------------------------------------------------------
// Suite files
// ---------------------------------------------------------------------------

describe("suite files", () => {
  it("writes deterministic, readable JSON", async () => {
    const good = await recordGood();
    const { testCase } = freeze({ trace: good, now: 1_700_000_000_000 });

    const first = formatSuite({ name: "s", baselineCommit: null, cases: [testCase] });
    const second = formatSuite({ name: "s", baselineCommit: null, cases: [testCase] });

    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    // Fields appear in reading order, not alphabetical order.
    expect(first.indexOf('"id"')).toBeLessThan(first.indexOf('"assertions"'));
  });

  it("replaces an existing case frozen from the same trace", async () => {
    const store = new SuiteStore(join(root, "suites"));
    const good = await recordGood();

    const first = freeze({ trace: good });
    const second = freeze({ trace: good, drop: [1] });

    expect((await store.addCase("default", first.testCase)).replaced).toBe(false);
    expect((await store.addCase("default", second.testCase)).replaced).toBe(true);

    const suite = await store.read("default");
    expect(suite.cases.length).toBe(1);
    expect(suite.cases[0]!.id).toBe(second.testCase.id);
  });

  it("round-trips through disk", async () => {
    const store = new SuiteStore(join(root, "suites"));
    const good = await recordGood();
    const { testCase } = freeze({ trace: good, tags: ["p0"] });

    const { path } = await store.addCase("regression", testCase);
    expect(await readFile(path, "utf8")).toContain('"p0"');

    const suite = await store.read("regression");
    expect(suite.cases[0]).toEqual(testCase);
    expect(await store.list()).toEqual(["regression"]);
  });

  it("rejects a suite name that would escape the directory", async () => {
    const store = new SuiteStore(join(root, "suites"));
    await expect(store.read("../../etc/passwd")).rejects.toThrow(/Invalid suite name/);
  });
});
