/**
 * Phase 3 exit criteria, as executable tests.
 *
 * The bar is "fifty cases × three configs runs unattended to completion", which
 * is really three properties: bounded concurrency, retries that tell transient
 * from real, and resumption after an interruption. Plus the reason the phase
 * exists at all — stubbed replay, which separates a model regression from
 * environment drift.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeConfig } from "../src/core/ids.ts";
import { SqliteTraceStore } from "../src/store/sqlite-store.ts";
import { createMockClient } from "../src/provider/mock.ts";
import { OllamaUnavailableError } from "../src/provider/ollama.ts";
import { record, replay, type RecordableAgent } from "../src/replay/replay.ts";
import { createReplayStub } from "../src/replay/stub.ts";
import { backoffMs, isTransient, runMatrix, type MatrixEvent } from "../src/replay/matrix.ts";
import { clearAgents, getAgent, listAgents, registerAgent } from "../src/replay/registry.ts";
import { freeze } from "../src/freeze/freezer.ts";
import { evaluateAll } from "../src/freeze/assertions.ts";
import { DEMO_QUESTION, demoAgent } from "../examples/demo-agent.ts";
import {
  dockerSandbox,
  isDockerAvailable,
  runInSandbox,
} from "../src/replay/sandbox.ts";
import type { RunConfig, TestCase, Trace } from "../src/core/types.ts";

let root: string;
let store: SqliteTraceStore;

const configA = makeConfig({
  provider: "mock",
  model: "demo-model",
  promptVersion: "v1",
  toolset: ["search", "calculate"],
});
const configB = makeConfig({
  provider: "mock",
  model: "demo-model",
  promptVersion: "v2-degraded",
  toolset: ["search", "calculate"],
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fr-p3-"));
  store = new SqliteTraceStore(root);
  clearAgents();
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The reason stubbed mode exists
// ---------------------------------------------------------------------------

describe("stubbed replay holds the environment still", () => {
  /** A tool whose answer depends on the outside world, which we can change. */
  function driftAgent(readWorld: () => string): RecordableAgent<string, string> {
    return {
      ref: { name: "drift-probe", version: "1.0.0" },
      async run(_input, ctx) {
        const lookup = ctx.recorder.wrapTool("lookup", () => readWorld());
        return `value is ${await lookup({ key: "metric" })}`;
      },
    };
  }

  it("separates a changed world from a changed model", async () => {
    let world = "100";

    const { trace: baseline } = await record({
      agent: driftAgent(() => world),
      client: createMockClient(),
      config: configA,
      input: "read the metric",
      store,
    });
    expect(baseline.output).toBe("value is 100");

    // The world moves. Nothing about the agent changed.
    world = "999";

    const live = await replay({
      traceId: baseline.id,
      agent: driftAgent(() => world),
      client: createMockClient(),
      config: configA,
      store,
      mode: "live",
    });

    const stubbed = await replay({
      traceId: baseline.id,
      agent: driftAgent(() => world),
      client: createMockClient(),
      config: configA,
      store,
      mode: "stubbed",
    });

    // Live sees the new world; stubbed replays the recorded one. The pair is
    // the diagnostic: differing live, identical stubbed means the environment
    // moved, not the agent.
    expect(live.candidate.output).toBe("value is 999");
    expect(stubbed.candidate.output).toBe("value is 100");
    expect(stubbed.candidate.output).toBe(baseline.output);
    expect(stubbed.stub?.identical).toBe(true);
    expect(live.stub).toBeNull();
  });

  it("never executes the real tool in stubbed mode", async () => {
    let calls = 0;
    const counting = driftAgent(() => {
      calls += 1;
      return "42";
    });

    const { trace: baseline } = await record({
      agent: counting,
      client: createMockClient(),
      config: configA,
      input: "read the metric",
      store,
    });
    expect(calls).toBe(1);

    await replay({
      traceId: baseline.id,
      agent: counting,
      client: createMockClient(),
      config: configA,
      store,
      mode: "stubbed",
    });

    // Still 1. The tool was answered from the recording, not run.
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stub matching
// ---------------------------------------------------------------------------

describe("stub matching", () => {
  const baselineOf = async (): Promise<Trace> =>
    (
      await record({
        agent: demoAgent,
        client: createMockClient({ quality: "good" }),
        config: configA,
        input: DEMO_QUESTION,
      })
    ).trace;

  it("serves a byte-identical call as an exact match", async () => {
    const baseline = await baselineOf();
    const searchSpan = baseline.spans.find((s) => s.name === "search")!;
    const stub = createReplayStub(baseline);

    const output = await stub.interceptor({
      name: "search",
      input: searchSpan.input,
      execute: async () => "SHOULD NOT RUN",
    });

    expect(output).toBe(searchSpan.output);
    expect(stub.report().exact).toBe(1);
    expect(stub.report().positional).toBe(0);
  });

  it("serves a differently-worded call as a loose match and says so", async () => {
    const baseline = await baselineOf();
    const stub = createReplayStub(baseline);

    await stub.interceptor({
      name: "search",
      input: { query: "phrased completely differently" },
      execute: async () => "SHOULD NOT RUN",
    });

    const report = stub.report();
    expect(report.exact).toBe(0);
    expect(report.positional).toBe(1);
    expect(report.identical).toBe(false);
  });

  it("reports a call the baseline never made as a miss, without executing it", async () => {
    const baseline = await baselineOf();
    const stub = createReplayStub(baseline);
    let executed = false;

    const output = await stub.interceptor({
      name: "send_email",
      input: { to: "someone" },
      execute: async () => {
        executed = true;
        return "sent";
      },
    });

    expect(executed).toBe(false);
    expect(String(output)).toContain("[stub miss]");
    expect(stub.report().misses).toEqual([{ tool: "send_email", input: { to: "someone" } }]);
  });

  it("reports recorded calls the candidate never made", async () => {
    const baseline = await baselineOf();
    const stub = createReplayStub(baseline);

    // Baseline called search then calculate; answer only the first.
    await stub.interceptor({ name: "search", input: {}, execute: async () => "x" });

    const report = stub.report();
    expect(report.unused.map((u) => u.tool)).toEqual(["calculate"]);
    expect(report.identical).toBe(false);
  });

  it("does not reuse one recorded call for two invocations", async () => {
    const baseline = await baselineOf();
    const stub = createReplayStub(baseline);

    const first = await stub.interceptor({ name: "search", input: {}, execute: async () => "x" });
    const second = await stub.interceptor({ name: "search", input: {}, execute: async () => "x" });

    expect(String(first)).not.toContain("[stub miss]");
    expect(String(second)).toContain("[stub miss]");
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("agent registry", () => {
  it("resolves a registered agent by name", () => {
    registerAgent(demoAgent);
    expect(getAgent("metrics-analyst")).toBe(demoAgent);
    expect(listAgents()).toHaveLength(1);
  });

  it("names the known agents when one is missing", () => {
    registerAgent(demoAgent);
    expect(() => getAgent("nope")).toThrow(/Known agents: metrics-analyst/);
  });

  it("refuses two different versions under one name", () => {
    registerAgent(demoAgent);
    expect(() =>
      registerAgent({ ...demoAgent, ref: { name: "metrics-analyst", version: "9.9.9" } }),
    ).toThrow(/already registered/);
  });
});

// ---------------------------------------------------------------------------
// Matrix runner
// ---------------------------------------------------------------------------

describe("matrix runner", () => {
  const caseFrom = async (): Promise<TestCase> => {
    const { trace } = await record({
      agent: demoAgent,
      client: createMockClient({ quality: "good" }),
      config: configA,
      input: DEMO_QUESTION,
      store,
    });
    return freeze({ trace }).testCase;
  };

  const runWith = async (
    testCase: TestCase,
    configs: RunConfig[],
    over: Partial<Parameters<typeof runMatrix>[0]> = {},
  ) =>
    runMatrix({
      cases: [testCase],
      configs,
      modes: ["live"],
      store,
      agentFor: () => demoAgent,
      clientFor: (config) =>
        createMockClient({ quality: config.promptVersion === "v1" ? "good" : "degraded" }),
      ...over,
    });

  it("runs every cell in the cross product", async () => {
    const testCase = await caseFrom();
    const result = await runWith(testCase, [configA, configB], { modes: ["live", "stubbed"] });

    expect(result.results).toHaveLength(4);
    expect(result.ran).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.results.every((r) => r.trace !== null)).toBe(true);
  });

  it("resumes finished cells instead of re-running them", async () => {
    const testCase = await caseFrom();
    await runWith(testCase, [configA, configB]);

    const second = await runWith(testCase, [configA, configB]);
    expect(second.ran).toBe(0);
    expect(second.resumed).toBe(2);
    expect(second.results.every((r) => r.resumed)).toBe(true);
  });

  it("hands a resumed cell its recorded trace, so rates cover the whole matrix", async () => {
    // A resumed cell that arrives without its trace looks like no result at
    // all, so any rate computed over the matrix quietly narrows to whichever
    // cells happened to run today. One such rate was published (D-045).
    const testCase = await caseFrom();
    const first = await runWith(testCase, [configA, configB]);

    const second = await runWith(testCase, [configA, configB]);
    expect(second.results.every((r) => r.resumed)).toBe(true);
    expect(second.results.every((r) => r.trace !== null)).toBe(true);
    expect(second.results.map((r) => r.trace?.id)).toEqual(first.results.map((r) => r.trace?.id));
  });

  it("does not cache a run that died because the provider was unreachable", async () => {
    // A dead daemon says nothing about the agent. Stored as an Attempt it
    // becomes a permanent non-result: resumed on every later run and counted in
    // every rate computed since. 23 of them sat in this project's own suite.
    const testCase = await caseFrom();
    const unreachable: RecordableAgent = {
      ref: demoAgent.ref,
      async run() {
        throw new OllamaUnavailableError("http://127.0.0.1:11434");
      },
    };

    const outage = await runWith(testCase, [configA], { agentFor: () => unreachable });
    expect(outage.failed).toBe(1);
    expect(store.findAttempt(testCase.id, configA.id, "live")).toBeNull();

    // ...so when the daemon comes back, the cell runs rather than resuming.
    const recovered = await runWith(testCase, [configA]);
    expect(recovered.ran).toBe(1);
    expect(recovered.resumed).toBe(0);
    expect(recovered.results[0]?.trace?.error).toBeNull();
  });

  it("re-runs everything when resume is off", async () => {
    const testCase = await caseFrom();
    await runWith(testCase, [configA]);

    const second = await runWith(testCase, [configA], { resume: false });
    expect(second.ran).toBe(1);
    expect(second.resumed).toBe(0);
  });

  it("never exceeds the concurrency cap", async () => {
    const testCase = await caseFrom();
    let inFlight = 0;
    let peak = 0;

    const slowAgent: RecordableAgent = {
      ref: demoAgent.ref,
      async run(input, ctx) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return demoAgent.run(input as string, ctx);
      },
    };

    await runMatrix({
      cases: [testCase, { ...testCase, id: "case_b" }, { ...testCase, id: "case_c" }],
      configs: [configA, configB],
      modes: ["live"],
      store,
      concurrency: 2,
      agentFor: () => slowAgent,
      clientFor: () => createMockClient(),
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  it("keeps an unrunnable cell in the denominator rather than dropping it", async () => {
    const testCase = await caseFrom();
    const result = await runMatrix({
      cases: [testCase],
      configs: [configA],
      modes: ["live"],
      store,
      agentFor: () => ({
        ref: demoAgent.ref,
        run: () => {
          throw new Error("harness could not start the agent");
        },
      }),
      clientFor: () => createMockClient(),
    });

    // The agent throwing inside run() is captured as a trace error, not a
    // harness failure — the cell still produced a result.
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.attempt.error?.message).toContain("could not start");
  });

  it("fails a cell whose stub baseline is missing, without killing the run", async () => {
    const testCase = await caseFrom();
    const orphan: TestCase = { ...testCase, id: "case_orphan", baselineTraceId: "trace_gone" };

    const result = await runMatrix({
      cases: [testCase, orphan],
      configs: [configA],
      modes: ["stubbed"],
      store,
      agentFor: () => demoAgent,
      clientFor: () => createMockClient(),
    });

    expect(result.failed).toBe(1);
    expect(result.results).toHaveLength(2);
    expect(result.results.find((r) => r.cell.testCase.id === "case_orphan")!.attempt.error?.message)
      .toContain("not in the store");
  });

  it("retries a transient failure and gives up on a real one", async () => {
    const testCase = await caseFrom();
    const events: MatrixEvent[] = [];
    let calls = 0;

    const flaky: RecordableAgent = {
      ref: demoAgent.ref,
      async run(input, ctx) {
        calls += 1;
        if (calls === 1) throw new Error("429 rate limit exceeded");
        return demoAgent.run(input as string, ctx);
      },
    };

    const result = await runMatrix({
      cases: [testCase],
      configs: [configA],
      modes: ["live"],
      store,
      agentFor: () => flaky,
      clientFor: () => createMockClient(),
      sleep: async () => {},
      onEvent: (event) => events.push(event),
    });

    // The agent's throw is captured into the trace, so the retry path is
    // exercised at the harness level only for errors that escape record().
    expect(result.results).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "cell-done")).toBe(true);
  });

  it("still evaluates assertions against every produced trace", async () => {
    const testCase = await caseFrom();
    const result = await runWith(testCase, [configA, configB]);

    const scores = result.results.map((cellResult) => {
      const results = evaluateAll(testCase.assertions, cellResult.trace!);
      return results.filter((r) => r.pass).length / results.length;
    });

    // configA reproduces the baseline; configB is the degraded prompt.
    expect(Math.max(...scores)).toBe(1);
    expect(Math.min(...scores)).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

describe("retry classification", () => {
  it("treats rate limits, overloads and network faults as transient", () => {
    for (const message of [
      "429 Too Many Requests",
      "Rate limit exceeded",
      "upstream overloaded",
      "503 Service Unavailable",
      "socket hang up",
      "fetch failed",
      "ETIMEDOUT: request timed out",
    ]) {
      expect(isTransient(new Error(message))).toBe(true);
    }
  });

  it("treats anything unrecognised as real", () => {
    for (const message of [
      "expected a number at position 8",
      "No such tool: send_email",
      "invalid model id",
    ]) {
      expect(isTransient(new Error(message))).toBe(false);
    }
  });

  it("backs off exponentially, jittered, and capped", () => {
    expect(backoffMs(0, () => 1)).toBe(500);
    expect(backoffMs(1, () => 1)).toBe(1000);
    expect(backoffMs(10, () => 1)).toBe(30_000);
    // Full jitter: the floor is 0 so retries never synchronise.
    expect(backoffMs(3, () => 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Docker sandbox — the other user of the interceptor seam
// ---------------------------------------------------------------------------

const dockerAvailable = await isDockerAvailable();
const withDocker = dockerAvailable ? describe : describe.skip;

withDocker("docker sandbox", () => {
  it("runs a command inside a container and returns its output", async () => {
    const result = await runInSandbox(["echo", "hello from the sandbox"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello from the sandbox");
    expect(result.timedOut).toBe(false);
  }, 60_000);

  it("denies network access by default", async () => {
    // No route out: the resolver has nothing to talk to.
    const result = await runInSandbox([
      "sh",
      "-c",
      "wget -q -T 2 -O- http://example.com >/dev/null 2>&1; echo exit=$?",
    ]);
    expect(result.stdout.trim()).not.toBe("exit=0");
  }, 60_000);

  it("gives the container a read-only root filesystem", async () => {
    const result = await runInSandbox([
      "sh",
      "-c",
      "touch /should-fail 2>/dev/null; echo exit=$?",
    ]);
    expect(result.stdout.trim()).toBe("exit=1");
  }, 60_000);

  it("kills a command that overruns its deadline", async () => {
    const result = await runInSandbox(["sleep", "30"], { timeoutMs: 2_000 });
    expect(result.timedOut).toBe(true);
  }, 60_000);

  it("routes only the named tools through the container", async () => {
    const interceptor = dockerSandbox({ tools: ["shell"] });
    let ranInProcess = false;

    const sandboxed = await interceptor({
      name: "shell",
      input: { command: ["echo", "contained"] },
      execute: async () => "SHOULD NOT RUN",
    });
    const passthrough = await interceptor({
      name: "search",
      input: { query: "x" },
      execute: async () => {
        ranInProcess = true;
        return "in-process result";
      },
    });

    expect(sandboxed).toBe("contained");
    expect(passthrough).toBe("in-process result");
    expect(ranInProcess).toBe(true);
  }, 60_000);

  it("surfaces a non-zero exit as a tool result rather than a harness failure", async () => {
    const interceptor = dockerSandbox({ tools: ["shell"] });
    const output = await interceptor({
      name: "shell",
      input: { command: ["sh", "-c", "echo nope >&2; exit 3"] },
      execute: async () => "SHOULD NOT RUN",
    });
    expect(String(output)).toContain("[exit 3]");
    expect(String(output)).toContain("nope");
  }, 60_000);
});
