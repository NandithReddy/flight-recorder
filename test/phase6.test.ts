/**
 * Phase 6 exit criteria, as executable tests.
 *
 * The bar is "a deliberately worsened prompt fails CI on a real pull request".
 * What is testable here is the decision the gate makes and the portability the
 * gate depends on — a committed suite whose baselines live only on one laptop
 * cannot fail anyone's build but its author's.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeConfig, newId } from "../src/core/ids.ts";
import { SqliteTraceStore } from "../src/store/sqlite-store.ts";
import { record } from "../src/replay/replay.ts";
import { createMockClient } from "../src/provider/mock.ts";
import { freeze } from "../src/freeze/freezer.ts";
import { buildReport } from "../src/report/build.ts";
import { evaluateGate, formatGate } from "../src/gate/gate.ts";
import {
  checkSuiteRunnable,
  exportSuiteTraces,
  importTraceBundle,
  IncompatibleBundleError,
  requiredTraceIds,
} from "../src/store/portable.ts";
import { DEMO_QUESTION, demoAgent } from "../examples/demo-agent.ts";
import type { SuiteFile } from "../src/freeze/suite.ts";
import type { Attempt, TestCase, Trace } from "../src/core/types.ts";
import type { ReportData } from "../src/report/build.ts";

let root: string;
let store: SqliteTraceStore;

const baselineConfig = makeConfig({
  provider: "mock",
  model: "demo-model",
  promptVersion: "v1",
  toolset: ["search", "calculate"],
});
const candidateConfig = makeConfig({
  provider: "mock",
  model: "demo-model",
  promptVersion: "v2-degraded",
  toolset: ["search", "calculate"],
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fr-p6-"));
  store = new SqliteTraceStore(root);
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

const traceOf = async (quality: "good" | "degraded"): Promise<Trace> =>
  (
    await record({
      agent: demoAgent,
      client: createMockClient({ quality }),
      config: quality === "good" ? baselineConfig : candidateConfig,
      input: DEMO_QUESTION,
      store,
    })
  ).trace;

function attemptFor(caseId: string, configId: string, traceId: string): Attempt {
  return {
    id: newId("attempt"),
    caseId,
    configId,
    mode: "live",
    traceId,
    startedAt: 1,
    endedAt: 2,
    error: null,
  };
}

/** A report with `n` cases, `regressions` of which break, optionally tagged. */
async function reportWith(n: number, regressions: number, tags: string[] = []) {
  const good = await traceOf("good");
  const bad = await traceOf("degraded");
  const template = freeze({ trace: good }).testCase;

  const cases: TestCase[] = [];
  for (let i = 0; i < n; i += 1) {
    const testCase: TestCase = {
      ...template,
      id: `case_${i}`,
      tags: i < regressions ? tags : [],
      assertions: template.assertions.map((a) => ({ ...a, id: `${a.id}_${i}` })),
    };
    cases.push(testCase);
    store.putAttempt(attemptFor(testCase.id, baselineConfig.id, good.id));
    store.putAttempt(
      attemptFor(testCase.id, candidateConfig.id, i < regressions ? bad.id : good.id),
    );
  }

  const suite: SuiteFile = { name: "s", baselineCommit: null, cases };
  return buildReport({
    suite,
    store,
    baselineConfig,
    candidateConfig,
    iterations: 2000,
    now: 1,
  });
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

describe("the gate", () => {
  it("passes a clean run", async () => {
    const report = await reportWith(20, 0);
    const result = evaluateGate(report);

    expect(result.status).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(result.failures).toHaveLength(0);
  });

  it("fails a significant pass-rate drop", async () => {
    const report = await reportWith(20, 14);
    const result = evaluateGate(report);

    expect(report.passRateDelta.significant).toBe(true);
    expect(result.status).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.failures.map((f) => f.rule)).toContain("pass-rate");
  });

  it("does not block on a drop too small to distinguish from noise", async () => {
    // One regression in forty. Real, but not evidence of anything, and a gate
    // that fires here is a gate people learn to override.
    const report = await reportWith(40, 1);
    const result = evaluateGate(report);

    expect(report.passRateDelta.point).toBeLessThan(0);
    expect(report.passRateDelta.significant).toBe(false);
    expect(result.status).toBe("pass");
    expect(
      result.findings.find((f) => f.rule === "pass-rate")?.detail,
    ).toContain("not blocking on noise");
  });

  it("fails on a single p0 regression whatever the aggregate says", async () => {
    // One case in forty — statistically nothing, but tagged as load-bearing.
    const report = await reportWith(40, 1, ["p0"]);
    const result = evaluateGate(report);

    expect(report.passRateDelta.significant).toBe(false);
    expect(result.status).toBe("fail");
    expect(result.failures.map((f) => f.rule)).toContain("p0-regression");
    expect(result.failures.find((f) => f.rule === "p0-regression")?.cases).toHaveLength(1);
  });

  it("honours a custom critical tag", async () => {
    const report = await reportWith(20, 1, ["billing"]);
    expect(evaluateGate(report).status).toBe("pass");
    expect(evaluateGate(report, { criticalTag: "billing" }).status).toBe("fail");
  });

  it("can be told to block on any regression at all", async () => {
    const report = await reportWith(40, 1);
    expect(evaluateGate(report).status).toBe("pass");
    expect(evaluateGate(report, { failOnAnyRegression: true }).status).toBe("fail");
  });

  it("fails on a cost ceiling", async () => {
    const report = await reportWith(10, 0);
    const result = evaluateGate(report, { maxCostPerTaskUsd: 0 });
    expect(result.failures.map((f) => f.rule)).toContain("cost-ceiling");
  });

  it("fails on a latency ceiling", async () => {
    const report = await reportWith(10, 0);
    const result = evaluateGate(report, { maxLatencyP95Ms: -1 });
    expect(result.failures.map((f) => f.rule)).toContain("latency-ceiling");
  });

  it("never blocks a build on an untrusted verdict", async () => {
    const report = await reportWith(20, 14);
    // Simulate every regression having been decided by an uncalibrated judge.
    const untrusted: ReportData = {
      ...report,
      regressions: report.regressions.map((o) => ({ ...o, trusted: false })),
    };

    const result = evaluateGate(untrusted, { failOnAnyRegression: true });
    expect(result.ignoredUntrusted).toBe(report.regressions.length);
    expect(result.failures.map((f) => f.rule)).not.toContain("any-regression");
  });

  it("prints a summary that names every rule, passed or failed", async () => {
    const report = await reportWith(20, 14);
    const text = formatGate(report, evaluateGate(report, { maxCostPerTaskUsd: 1 }));

    expect(text).toContain("FAIL");
    expect(text).toContain("pass-rate");
    expect(text).toContain("p0-regression");
    expect(text).toContain("cost-ceiling");
  });
});

// ---------------------------------------------------------------------------
// Portability — what the gate runs on
// ---------------------------------------------------------------------------

describe("suite portability", () => {
  async function suiteAndBundle() {
    const good = await traceOf("good");
    const testCase = freeze({ trace: good }).testCase;
    const suite: SuiteFile = { name: "s", baselineCommit: null, cases: [testCase] };
    const path = join(root, "bundle.json");
    const result = await exportSuiteTraces({ suite, store, path, now: 1 });
    return { suite, path, result, good };
  }

  it("lists every trace a suite needs", async () => {
    const good = await traceOf("good");
    const testCase = freeze({ trace: good }).testCase;
    const ids = requiredTraceIds({ name: "s", baselineCommit: null, cases: [testCase] });
    expect(ids).toContain(good.id);
  });

  it("makes a suite runnable on a store that has never seen it", async () => {
    const { suite, path } = await suiteAndBundle();

    const fresh = new SqliteTraceStore(join(root, "fresh"));
    expect((await checkSuiteRunnable(suite, fresh)).runnable).toBe(false);

    const imported = await importTraceBundle({ store: fresh, path });
    expect(imported.imported).toBe(1);
    expect((await checkSuiteRunnable(suite, fresh)).runnable).toBe(true);
    fresh.close();
  });

  it("is idempotent — importing twice changes nothing", async () => {
    const { path } = await suiteAndBundle();
    const fresh = new SqliteTraceStore(join(root, "fresh2"));

    const first = await importTraceBundle({ store: fresh, path });
    const second = await importTraceBundle({ store: fresh, path });

    expect(first.imported).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    fresh.close();
  });

  it("round-trips a trace without losing anything", async () => {
    const { path, good } = await suiteAndBundle();
    const fresh = new SqliteTraceStore(join(root, "fresh3"));
    await importTraceBundle({ store: fresh, path });

    expect(await fresh.get(good.id)).toEqual(good);
    fresh.close();
  });

  it("reports referenced traces it could not find instead of writing a broken bundle", async () => {
    const good = await traceOf("good");
    const orphan: TestCase = {
      ...freeze({ trace: good }).testCase,
      id: "case_orphan",
      baselineTraceId: "trace_gone",
      sourceTraceId: "trace_gone",
    };

    const result = await exportSuiteTraces({
      suite: { name: "s", baselineCommit: null, cases: [orphan] },
      store,
      path: join(root, "partial.json"),
      now: 1,
    });

    expect(result.exported).toBe(0);
    expect(result.missing).toContain("trace_gone");
  });

  it("refuses a bundle written by an incompatible version", async () => {
    const path = join(root, "future.json");
    await writeFile(path, JSON.stringify({ version: 99, traces: [] }), "utf8");

    const fresh = new SqliteTraceStore(join(root, "fresh4"));
    await expect(importTraceBundle({ store: fresh, path })).rejects.toThrow(
      IncompatibleBundleError,
    );
    fresh.close();
  });

  it("says so plainly when the bundle is not there", async () => {
    await expect(
      importTraceBundle({ store, path: join(root, "nope.json") }),
    ).rejects.toThrow(/No trace bundle at/);
  });
});

describe("baseline source", () => {
  it("catches a regression that made both sides equally worse", async () => {
    // A change that breaks the agent shows up in the baseline run *and* the
    // candidate run, so a fresh-vs-fresh delta is zero and the gate passes.
    // Against the committed reference, it is caught.
    const good = await traceOf("good");
    const bad = await traceOf("degraded");
    const template = freeze({ trace: good }).testCase;

    const cases: TestCase[] = [];
    for (let i = 0; i < 12; i += 1) {
      const testCase: TestCase = {
        ...template,
        id: `case_${i}`,
        assertions: template.assertions.map((a) => ({ ...a, id: `${a.id}_${i}` })),
      };
      cases.push(testCase);
      // Both sides run the broken code.
      store.putAttempt(attemptFor(testCase.id, baselineConfig.id, bad.id));
      store.putAttempt(attemptFor(testCase.id, candidateConfig.id, bad.id));
    }
    const suite: SuiteFile = { name: "s", baselineCommit: null, cases };

    const fresh = await buildReport({
      suite, store, baselineConfig, candidateConfig, iterations: 1000, now: 1,
    });
    const committed = await buildReport({
      suite, store, baselineConfig, candidateConfig, iterations: 1000, now: 1,
      baselineSource: "committed",
    });

    // Fresh-vs-fresh sees no change at all.
    expect(fresh.passRateDelta.point).toBe(0);
    expect(evaluateGate(fresh).status).toBe("pass");

    // Against the frozen reference, every case regressed.
    expect(committed.passRateBefore).toBe(100);
    expect(committed.passRateAfter).toBe(0);
    expect(evaluateGate(committed).status).toBe("fail");
  });
});
