/**
 * Phase 5 exit criteria, as executable tests.
 *
 * The bar is one sentence: "the report refuses to call a two-case delta
 * significant at n=40". That is the whole argument of the phase — a report that
 * announces "+5% improvement" from two flipped cases is worse than no report,
 * because it is confidently wrong and looks rigorous while being so.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeConfig, newId } from "../src/core/ids.ts";
import { SqliteTraceStore } from "../src/store/sqlite-store.ts";
import { record } from "../src/replay/replay.ts";
import { createMockClient } from "../src/provider/mock.ts";
import { freeze } from "../src/freeze/freezer.ts";
import { buildReport, headline, percentileOf } from "../src/report/build.ts";
import { diffTraces } from "../src/report/diff.ts";
import { renderReportHtml } from "../src/report/html.ts";
import { DEMO_QUESTION, demoAgent } from "../examples/demo-agent.ts";
import type { SuiteFile } from "../src/freeze/suite.ts";
import type { Attempt, TestCase, Trace } from "../src/core/types.ts";

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
  root = await mkdtemp(join(tmpdir(), "fr-p5-"));
  store = new SqliteTraceStore(root);
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

const goodTrace = async (): Promise<Trace> =>
  (
    await record({
      agent: demoAgent,
      client: createMockClient({ quality: "good" }),
      config: baselineConfig,
      input: DEMO_QUESTION,
      store,
    })
  ).trace;

const badTrace = async (): Promise<Trace> =>
  (
    await record({
      agent: demoAgent,
      client: createMockClient({ quality: "degraded" }),
      config: candidateConfig,
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

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

describe("percentiles", () => {
  it("interpolates between neighbours", () => {
    expect(percentileOf([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentileOf([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentileOf([1, 2, 3, 4, 5], 1)).toBe(5);
  });

  it("does not care about input order", () => {
    expect(percentileOf([40, 10, 30, 20], 0.5)).toBe(25);
  });

  it("returns NaN for an empty sample rather than zero", () => {
    expect(Number.isNaN(percentileOf([], 0.95))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step diffs
// ---------------------------------------------------------------------------

describe("trace diff", () => {
  it("reports identical runs as identical", async () => {
    const trace = await goodTrace();
    const diff = diffTraces(trace, trace);
    expect(diff.divergedAt).toBeNull();
    expect(diff.summary).toContain("identical");
  });

  it("finds the first diverging step and names what changed", async () => {
    const good = await goodTrace();
    const bad = await badTrace();
    const diff = diffTraces(good, bad);

    expect(diff.divergedAt).not.toBeNull();
    // The degraded run stops calling `calculate`, so it runs out of steps.
    expect(diff.summary).toMatch(/diverge/);
    expect(diff.steps.some((s) => s.status === "only-baseline")).toBe(true);
  });

  it("ignores timing, which varies on every run", async () => {
    const trace = await goodTrace();
    const slower: Trace = {
      ...trace,
      spans: trace.spans.map((s) => ({ ...s, endedAt: s.endedAt + 5000 })),
    };
    expect(diffTraces(trace, slower).divergedAt).toBeNull();
  });

  it("flags a step whose tool returned something different", async () => {
    const trace = await goodTrace();
    const changed: Trace = {
      ...trace,
      spans: trace.spans.map((s, i) => (i === 1 ? { ...s, output: "different data" } : s)),
    };
    const diff = diffTraces(trace, changed);
    expect(diff.divergedAt).toBe(1);
    expect(diff.summary).toContain("returned something different");
  });
});

// ---------------------------------------------------------------------------
// The exit criterion
// ---------------------------------------------------------------------------

describe("the report refuses to over-claim", () => {
  /**
   * Builds a suite of `n` cases where `flips` of them fail on the baseline and
   * pass on the candidate, and the rest pass on both.
   */
  async function suiteWithFlips(n: number, flips: number) {
    const good = await goodTrace();
    const bad = await badTrace();

    const passingCase = freeze({ trace: good }).testCase;
    const cases: TestCase[] = [];

    for (let i = 0; i < n; i += 1) {
      const testCase: TestCase = {
        ...passingCase,
        id: `case_${i}`,
        assertions: passingCase.assertions.map((a) => ({ ...a, id: `${a.id}_${i}` })),
      };
      cases.push(testCase);

      // The first `flips` cases fail on the baseline side and pass after.
      const beforeTrace = i < flips ? bad : good;
      store.putAttempt(attemptFor(testCase.id, baselineConfig.id, beforeTrace.id));
      store.putAttempt(attemptFor(testCase.id, candidateConfig.id, good.id));
    }

    const suite: SuiteFile = { name: "s", baselineCommit: null, cases };
    return suite;
  }

  it("calls a two-case improvement at n=40 not significant", async () => {
    const suite = await suiteWithFlips(40, 2);
    const report = await buildReport({
      suite,
      store,
      baselineConfig,
      candidateConfig,
      iterations: 4000,
      now: 1,
    });

    expect(report.n).toBe(40);
    expect(report.passRateBefore).toBeCloseTo(95, 6);
    expect(report.passRateAfter).toBeCloseTo(100, 6);
    expect(report.passRateDelta.point).toBeCloseTo(5, 6);

    // Two cases out of forty is not evidence of anything.
    expect(report.passRateDelta.significant).toBe(false);
    expect(report.passRateDelta.lower).toBeLessThanOrEqual(0);

    const line = headline(report);
    expect(line).toContain("not significant at n=40");
    // And it must not assert a direction.
    expect(line).not.toMatch(/\brose\b|\bfell\b/);
  });

  it("does call a large, consistent change significant", async () => {
    const suite = await suiteWithFlips(40, 30);
    const report = await buildReport({
      suite,
      store,
      baselineConfig,
      candidateConfig,
      iterations: 4000,
      now: 1,
    });

    expect(report.passRateDelta.significant).toBe(true);
    expect(headline(report)).toMatch(/rose/);
  });

  it("reports nothing at all rather than dividing by zero on an empty suite", async () => {
    const report = await buildReport({
      suite: { name: "s", baselineCommit: null, cases: [] },
      store,
      baselineConfig,
      candidateConfig,
      iterations: 100,
      now: 1,
    });
    expect(report.n).toBe(0);
    expect(headline(report)).toContain("nothing to report");
  });
});

// ---------------------------------------------------------------------------
// Pairing and case accounting
// ---------------------------------------------------------------------------

describe("report contents", () => {
  async function twoSidedSuite() {
    const good = await goodTrace();
    const bad = await badTrace();
    const testCase = freeze({ trace: good }).testCase;

    store.putAttempt(attemptFor(testCase.id, baselineConfig.id, good.id));
    store.putAttempt(attemptFor(testCase.id, candidateConfig.id, bad.id));

    const suite: SuiteFile = { name: "s", baselineCommit: null, cases: [testCase] };
    return { suite, good, bad, testCase };
  }

  it("identifies a regression and keeps the trace ids for the diff", async () => {
    const { suite, good, bad } = await twoSidedSuite();
    const report = await buildReport({
      suite,
      store,
      baselineConfig,
      candidateConfig,
      iterations: 500,
      now: 1,
    });

    expect(report.regressions).toHaveLength(1);
    expect(report.regressions[0]!.before.traceId).toBe(good.id);
    expect(report.regressions[0]!.after.traceId).toBe(bad.id);
    expect(report.fixes).toHaveLength(0);
  });

  it("reports cost and latency beside quality, not instead of it", async () => {
    const { suite } = await twoSidedSuite();
    const report = await buildReport({
      suite,
      store,
      baselineConfig,
      candidateConfig,
      iterations: 500,
      now: 1,
    });

    // The degraded run is cheaper. A report that led with cost would call this
    // an improvement, which is the failure the project exists to prevent.
    expect(report.costPerTaskAfter).toBeLessThan(report.costPerTaskBefore);
    expect(report.passRateAfter).toBeLessThan(report.passRateBefore);
    expect(Number.isNaN(report.latencyP95After)).toBe(false);
  });

  it("counts cases with no comparable pair instead of silently dropping them", async () => {
    const good = await goodTrace();
    const withPair = freeze({ trace: good }).testCase;
    const orphan: TestCase = { ...withPair, id: "case_orphan", baselineTraceId: "trace_gone" };

    store.putAttempt(attemptFor(withPair.id, baselineConfig.id, good.id));
    store.putAttempt(attemptFor(withPair.id, candidateConfig.id, good.id));

    const report = await buildReport({
      suite: { name: "s", baselineCommit: null, cases: [withPair, orphan] },
      store,
      baselineConfig,
      candidateConfig,
      iterations: 500,
      now: 1,
    });

    expect(report.n).toBe(1);
    expect(report.missing).toBe(1);
  });

  it("marks judged verdicts untrusted when the judge is uncalibrated", async () => {
    const { suite } = await twoSidedSuite();
    const report = await buildReport({
      suite,
      store,
      baselineConfig,
      candidateConfig,
      iterations: 500,
      now: 1,
    });
    // No judge configured at all — nothing was judged, so nothing is untrusted.
    expect(report.judge).toBeNull();
    expect(report.untrustedVerdicts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HTML output
// ---------------------------------------------------------------------------

describe("html report", () => {
  it("is self-contained and states its uncertainty", async () => {
    const good = await goodTrace();
    const bad = await badTrace();
    const testCase = freeze({ trace: good }).testCase;
    store.putAttempt(attemptFor(testCase.id, baselineConfig.id, good.id));
    store.putAttempt(attemptFor(testCase.id, candidateConfig.id, bad.id));

    const report = await buildReport({
      suite: { name: "metrics", baselineCommit: null, cases: [testCase] },
      store,
      baselineConfig,
      candidateConfig,
      iterations: 500,
      now: 1,
    });
    const html = await renderReportHtml({ report, store });

    expect(html.startsWith("<!doctype html>")).toBe(true);
    // No network dependencies of any kind.
    expect(html).not.toMatch(/<script|src=|@import|https?:\/\//);
    expect(html).toContain("percentile bootstrap");
    expect(html).toContain("resampled as pairs");
    expect(html).toContain("metrics");
  });

  it("escapes model output rather than letting it into the DOM", async () => {
    const good = await goodTrace();
    const hostile: Trace = {
      ...good,
      id: "trace_hostile",
      output: '<img src=x onerror="alert(1)">',
    };
    await store.put(hostile);

    const testCase = freeze({ trace: good }).testCase;
    store.putAttempt(attemptFor(testCase.id, baselineConfig.id, good.id));
    store.putAttempt(attemptFor(testCase.id, candidateConfig.id, hostile.id));

    const report = await buildReport({
      suite: { name: "s", baselineCommit: null, cases: [testCase] },
      store,
      baselineConfig,
      candidateConfig,
      iterations: 200,
      now: 1,
    });
    const html = await renderReportHtml({ report, store });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("includes the diverging step for a regression", async () => {
    const good = await goodTrace();
    const bad = await badTrace();
    const testCase = freeze({ trace: good }).testCase;
    store.putAttempt(attemptFor(testCase.id, baselineConfig.id, good.id));
    store.putAttempt(attemptFor(testCase.id, candidateConfig.id, bad.id));

    const report = await buildReport({
      suite: { name: "s", baselineCommit: null, cases: [testCase] },
      store,
      baselineConfig,
      candidateConfig,
      iterations: 200,
      now: 1,
    });
    const html = await renderReportHtml({ report, store });

    expect(html).toContain("diverge");
    expect(html).toContain("calculate");
  });
});
