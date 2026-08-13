/**
 * Phase 4 exit criteria, as executable tests.
 *
 * The bar is "kappa ≥ 0.6 on 200 labelled examples; judging under 15% of run
 * cost". Kappa itself depends on a human, so what is testable here is the
 * machinery around it — and two pieces of that machinery would silently
 * invalidate every number if they were wrong:
 *
 *   - un-blinding a human label back to baseline/candidate
 *   - un-swapping the judge's A/B answer back to baseline/candidate
 *
 * Both are tested in both orders.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeConfig } from "../src/core/ids.ts";
import { bootstrap, describeInterval, seededRandom, seedFrom } from "../src/stats/bootstrap.ts";
import {
  cohensKappa,
  cohensKappaValue,
  interpretKappa,
  isTrustworthy,
  TRUST_THRESHOLD,
} from "../src/score/kappa.ts";
import {
  baselineSlotFor,
  createJudge,
  parseVerdict,
  type Judge,
  type JudgeItem,
} from "../src/score/judge.ts";
import { score, scoreTier1, isVerdictTrusted } from "../src/score/scorer.ts";
import {
  LabelStore,
  labelledItems,
  resolveChoice,
  unlabelledItems,
  type LabelItem,
} from "../src/score/labels.ts";
import { calibrate, MIN_LABELS, NotEnoughLabelsError } from "../src/score/calibration.ts";
import { record } from "../src/replay/replay.ts";
import { createMockClient } from "../src/provider/mock.ts";
import { freeze } from "../src/freeze/freezer.ts";
import { DEMO_QUESTION, demoAgent } from "../examples/demo-agent.ts";
import type { ModelClient } from "../src/provider/types.ts";
import type { Trace } from "../src/core/types.ts";

let root: string;

const config = makeConfig({
  provider: "mock",
  model: "demo-model",
  promptVersion: "v1",
  toolset: ["search", "calculate"],
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fr-p4-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeClient(reply: (prompt: string) => string): ModelClient {
  return {
    providerId: "fake",
    async generate(request) {
      const prompt = request.messages.map((m) => m.content).join("\n");
      return {
        text: reply(prompt),
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
        finishReason: "stop",
      };
    },
  };
}

const goodTrace = async (): Promise<Trace> =>
  (
    await record({
      agent: demoAgent,
      client: createMockClient({ quality: "good" }),
      config,
      input: DEMO_QUESTION,
    })
  ).trace;

const badTrace = async (): Promise<Trace> =>
  (
    await record({
      agent: demoAgent,
      client: createMockClient({ quality: "degraded" }),
      config,
      input: DEMO_QUESTION,
    })
  ).trace;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

describe("bootstrap", () => {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  it("is reproducible for a given seed", () => {
    const sample = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = bootstrap(sample, mean, { seed: "x", iterations: 500 });
    const b = bootstrap(sample, mean, { seed: "x", iterations: 500 });
    expect(a).toEqual(b);
  });

  it("brackets the point estimate", () => {
    const sample = Array.from({ length: 60 }, (_, i) => i);
    const result = bootstrap(sample, mean, { seed: 7, iterations: 2000 });
    expect(result.lower).toBeLessThanOrEqual(result.point);
    expect(result.upper).toBeGreaterThanOrEqual(result.point);
  });

  it("calls a delta that straddles zero not significant", () => {
    // Half +1, half -1: the mean is 0 and the interval must contain it.
    const sample = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const result = bootstrap(sample, mean, { seed: 3, iterations: 2000 });
    expect(result.significant).toBe(false);
    expect(describeInterval(result)).toContain("not significant at n=40");
  });

  it("calls a clear effect significant", () => {
    const sample = Array.from({ length: 60 }, () => 5);
    const result = bootstrap(sample, mean, { seed: 3, iterations: 500 });
    expect(result.significant).toBe(true);
  });

  it("survives an empty sample instead of dividing by zero", () => {
    const result = bootstrap([] as number[], () => Number.NaN, { iterations: 10 });
    expect(result.n).toBe(0);
    expect(describeInterval(result)).toBe("no data");
  });

  it("derives a stable seed from a string", () => {
    expect(seedFrom("abc")).toBe(seedFrom("abc"));
    expect(seedFrom("abc")).not.toBe(seedFrom("abd"));
    const rng = seededRandom(seedFrom("abc"));
    const value = rng();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Cohen's kappa
// ---------------------------------------------------------------------------

describe("cohen's kappa", () => {
  const pairsOf = (spec: [string, string, number][]) =>
    spec.flatMap(([human, judge, count]) =>
      Array.from({ length: count }, () => ({ human, judge })),
    );

  it("matches a worked textbook example", () => {
    // both yes 45, both no 25, disagreements 15 each way.
    // po = 0.70, pe = 0.52, kappa = 0.18 / 0.48 = 0.375
    const pairs = pairsOf([
      ["yes", "yes", 45],
      ["no", "no", 25],
      ["yes", "no", 15],
      ["no", "yes", 15],
    ]);
    expect(cohensKappaValue(pairs)).toBeCloseTo(0.375, 3);
  });

  it("is 1 for perfect agreement across categories", () => {
    const pairs = pairsOf([
      ["baseline", "baseline", 20],
      ["candidate", "candidate", 20],
      ["tie", "tie", 20],
    ]);
    expect(cohensKappaValue(pairs)).toBeCloseTo(1, 6);
  });

  it("is about zero for a judge that always guesses the majority", () => {
    // The judge says "tie" every time; 70% of labels are ties. Raw agreement
    // is a flattering 70% and kappa correctly reports that it learned nothing.
    const pairs = pairsOf([
      ["tie", "tie", 70],
      ["baseline", "tie", 15],
      ["candidate", "tie", 15],
    ]);
    const result = cohensKappa(pairs);
    expect(result.observedAgreement).toBeCloseTo(0.7, 6);
    expect(result.kappa).toBeCloseTo(0, 6);
  });

  it("goes negative when the judge is worse than chance", () => {
    const pairs = pairsOf([
      ["baseline", "candidate", 30],
      ["candidate", "baseline", 30],
    ]);
    expect(cohensKappaValue(pairs)).toBeLessThan(0);
  });

  it("reports an interval alongside the point estimate", () => {
    const pairs = pairsOf([
      ["yes", "yes", 45],
      ["no", "no", 25],
      ["yes", "no", 15],
      ["no", "yes", 15],
    ]);
    const result = cohensKappa(pairs);
    expect(result.interval.n).toBe(100);
    expect(result.interval.lower).toBeLessThan(result.kappa);
    expect(result.interval.upper).toBeGreaterThan(result.kappa);
  });

  it("builds a confusion matrix that totals the sample", () => {
    const pairs = pairsOf([
      ["baseline", "baseline", 3],
      ["baseline", "tie", 2],
      ["tie", "tie", 5],
    ]);
    const result = cohensKappa(pairs);
    const total = result.categories.flatMap((h) =>
      result.categories.map((j) => result.matrix[h]![j]!),
    );
    expect(total.reduce((a, b) => a + b, 0)).toBe(10);
    expect(result.matrix.baseline!.tie).toBe(2);
  });

  it("gates trust at the documented threshold", () => {
    expect(TRUST_THRESHOLD).toBe(0.6);
    expect(isTrustworthy(0.61)).toBe(true);
    expect(isTrustworthy(0.59)).toBe(false);
    expect(isTrustworthy(Number.NaN)).toBe(false);
    expect(interpretKappa(0.65)).toBe("substantial");
    expect(interpretKappa(-0.1)).toBe("worse than chance");
  });
});

// ---------------------------------------------------------------------------
// Judge — parsing and position control
// ---------------------------------------------------------------------------

describe("judge parsing", () => {
  it("reads well-formed JSON", () => {
    expect(parseVerdict('{"winner":"B","reason":"more accurate"}')).toEqual({
      winner: "B",
      reason: "more accurate",
      unparsed: false,
    });
  });

  it("reads JSON embedded in surrounding chatter", () => {
    const raw = 'Sure! Here is my verdict:\n{"winner": "tie", "reason": "equivalent"}\nHope that helps.';
    expect(parseVerdict(raw).winner).toBe("TIE");
  });

  it("falls back to scanning for a verdict token", () => {
    expect(parseVerdict("I think Answer A is better because it cites a source.").winner).toBe("A");
  });

  it("treats an unreadable reply as a tie and flags it", () => {
    const result = parseVerdict("I'm not sure how to compare these.");
    expect(result.winner).toBe("TIE");
    expect(result.unparsed).toBe(true);
  });
});

describe("judge position control", () => {
  const item = (id: string): JudgeItem => ({
    id,
    task: "compute the growth rate",
    baseline: "18.33%, from 1,200,000 to 1,420,000",
    candidate: "roughly 25%",
  });

  it("puts the baseline in a stable slot for a given item", () => {
    expect(baselineSlotFor("abc")).toBe(baselineSlotFor("abc"));
  });

  it("balances the slot across many items", () => {
    const slots = Array.from({ length: 400 }, (_, i) => baselineSlotFor(`item-${i}`));
    const asA = slots.filter((s) => s === "A").length;
    // Not a coin flip, but it must not be lopsided enough to bias the set.
    expect(asA).toBeGreaterThan(140);
    expect(asA).toBeLessThan(260);
  });

  it("maps the judge's answer back to baseline or candidate in both orders", async () => {
    // A judge that always names whichever slot holds the *candidate*.
    const alwaysPicksCandidate = createJudge({
      client: fakeClient((prompt) => {
        const aIsCandidate = prompt.indexOf("roughly 25%") < prompt.indexOf("18.33%");
        return `{"winner":"${aIsCandidate ? "A" : "B"}","reason":"x"}`;
      }),
      model: "fake",
    });

    // Two ids chosen so the baseline lands in each slot.
    const ids = ["item-0", "item-1", "item-2", "item-3"];
    const slots = new Set(ids.map(baselineSlotFor));
    expect(slots.size).toBe(2); // the fixture genuinely exercises both

    for (const id of ids) {
      const verdict = await alwaysPicksCandidate.judge(item(id));
      expect(verdict.winner).toBe("candidate");
    }
  });

  it("detects a judge that just picks whatever is shown first", async () => {
    const positionBiased = createJudge({
      client: fakeClient(() => '{"winner":"A","reason":"first looks better"}'),
      model: "fake",
    });

    const bias = await positionBiased.measurePositionBias(item("x"));
    // Always saying "A" means the verdict flips when the order flips — which is
    // exactly the signal this measurement exists to expose.
    expect(bias.flipped).toBe(true);
  });

  it("reports no flip for a judge that reads the content", async () => {
    const contentBased = createJudge({
      client: fakeClient((prompt) => {
        const aIsBaseline = prompt.indexOf("18.33%") < prompt.indexOf("roughly 25%");
        return `{"winner":"${aIsBaseline ? "A" : "B"}","reason":"cites figures"}`;
      }),
      model: "fake",
    });

    const bias = await contentBased.measurePositionBias(item("y"));
    expect(bias.flipped).toBe(false);
    expect(bias.verdicts.every((v) => v.winner === "baseline")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

describe("scoring ladder", () => {
  const neverCalled: Judge = {
    judge: async () => {
      throw new Error("the judge must not be called after a hard failure");
    },
    measurePositionBias: async () => {
      throw new Error("not used");
    },
  };

  it("fails on a hard assertion without ever calling the judge", async () => {
    const good = await goodTrace();
    const bad = await badTrace();
    const { testCase } = freeze({ trace: good });

    const result = await score({
      testCase,
      candidate: bad,
      baseline: good,
      judge: neverCalled,
      trust: 0.8,
    });

    expect(result.earlyExit).toBe(true);
    expect(result.verdict.pass).toBe(false);
    expect(result.verdict.decidedBy).toBe("deterministic");
    expect(result.verdict.failedAssertionIds.length).toBeGreaterThan(0);
    // Deterministic verdicts carry no trust caveat — they are not opinions.
    expect(result.verdict.trust).toBeNull();
    expect(isVerdictTrusted(result.verdict)).toBe(true);
  });

  it("decides on tier 1 alone when there is no judge", async () => {
    const good = await goodTrace();
    const { testCase } = freeze({ trace: good });

    const result = await score({ testCase, candidate: good, baseline: good });
    expect(result.verdict.pass).toBe(true);
    expect(result.verdict.decidedBy).toBe("deterministic");
    expect(result.judgeVerdict).toBeNull();
  });

  it("consults the judge when tier 1 passes", async () => {
    const good = await goodTrace();
    const { testCase } = freeze({ trace: good });
    let called = 0;

    const judge = createJudge({
      client: fakeClient(() => {
        called += 1;
        return '{"winner":"TIE","reason":"same answer"}';
      }),
      model: "fake",
    });

    const result = await score({ testCase, candidate: good, baseline: good, judge, trust: 0.72 });
    expect(called).toBe(1);
    expect(result.verdict.decidedBy).toBe("judge");
    expect(result.verdict.trust).toBe(0.72);
  });

  it("treats a tie as a pass — the question is whether it got worse", async () => {
    const good = await goodTrace();
    const { testCase } = freeze({ trace: good });
    const judge = createJudge({
      client: fakeClient(() => '{"winner":"TIE","reason":"equivalent"}'),
      model: "fake",
    });

    const result = await score({ testCase, candidate: good, baseline: good, judge });
    expect(result.verdict.pass).toBe(true);
    expect(result.verdict.score).toBe(0.5);
  });

  it("fails when the judge prefers the baseline", async () => {
    const good = await goodTrace();
    // No assertions, so tier 1 passes and the judge actually gets consulted.
    // Fixed ids, because the presentation slot is derived from them and a
    // verdict that depends on a random id is not a measurement.
    const { testCase } = freeze({ trace: good, assertions: [] });
    const fixedCase = { ...testCase, id: "case_fixed" };
    const worse: Trace = {
      ...good,
      id: "trace_worse",
      output: "Users grew a lot last quarter.",
    };

    const judge = createJudge({
      // Reads the content and names whichever slot holds the grounded answer.
      client: fakeClient((prompt) => {
        const a = prompt.slice(prompt.indexOf("ANSWER A:"), prompt.indexOf("ANSWER B:"));
        return `{"winner":"${a.includes("18.33") ? "A" : "B"}","reason":"cites figures"}`;
      }),
      model: "fake",
    });

    const result = await score({
      testCase: fixedCase,
      candidate: worse,
      baseline: good,
      judge,
      trust: 0.7,
    });

    expect(result.verdict.decidedBy).toBe("judge");
    expect(result.judgeVerdict?.winner).toBe("baseline");
    expect(result.verdict.pass).toBe(false);
    expect(result.verdict.score).toBe(0);
  });

  it("marks a judged verdict untrusted when kappa is below the threshold", async () => {
    const good = await goodTrace();
    const { testCase } = freeze({ trace: good });
    const judge = createJudge({
      client: fakeClient(() => '{"winner":"TIE","reason":"x"}'),
      model: "fake",
    });

    const low = await score({ testCase, candidate: good, baseline: good, judge, trust: 0.41 });
    const high = await score({ testCase, candidate: good, baseline: good, judge, trust: 0.71 });

    expect(isVerdictTrusted(low.verdict)).toBe(false);
    expect(isVerdictTrusted(high.verdict)).toBe(true);
  });

  it("marks an uncalibrated judge untrusted rather than assuming the best", async () => {
    const good = await goodTrace();
    const { testCase } = freeze({ trace: good });
    const judge = createJudge({
      client: fakeClient(() => '{"winner":"TIE","reason":"x"}'),
      model: "fake",
    });

    const result = await score({ testCase, candidate: good, baseline: good, judge });
    expect(result.verdict.trust).toBeNull();
    expect(isVerdictTrusted(result.verdict)).toBe(false);
  });

  it("exposes tier 1 on its own for callers that only want the cheap check", async () => {
    const good = await goodTrace();
    const bad = await badTrace();
    const { testCase } = freeze({ trace: good });

    expect(scoreTier1(testCase.assertions, good).pass).toBe(true);
    expect(scoreTier1(testCase.assertions, bad).pass).toBe(false);
    expect(scoreTier1(testCase.assertions, bad).hardFailures.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Labels — the blinding
// ---------------------------------------------------------------------------

describe("label set", () => {
  const item = (presentedFirst: "baseline" | "candidate"): LabelItem => ({
    id: "label_1",
    task: "t",
    baseline: "b",
    candidate: "c",
    presentedFirst,
    human: null,
    labelledAt: null,
    caseId: null,
    baselineTraceId: null,
    candidateTraceId: null,
    baselineModel: null,
    candidateModel: null,
  });

  it("un-blinds a choice correctly in both presentation orders", () => {
    // Baseline shown first: "1" means baseline.
    expect(resolveChoice(item("baseline"), "1")).toBe("baseline");
    expect(resolveChoice(item("baseline"), "2")).toBe("candidate");
    // Candidate shown first: "1" now means candidate.
    expect(resolveChoice(item("candidate"), "1")).toBe("candidate");
    expect(resolveChoice(item("candidate"), "2")).toBe("baseline");
    // A tie is a tie either way.
    expect(resolveChoice(item("baseline"), "tie")).toBe("tie");
    expect(resolveChoice(item("candidate"), "tie")).toBe("tie");
  });

  it("shuffles presentation across items so the set is not anchored", async () => {
    const store = new LabelStore(join(root, "labels"));
    let flip = 0;
    await store.addItems(
      "s",
      Array.from({ length: 200 }, (_, i) => ({
        task: `t${i}`,
        baseline: `b${i}`,
        candidate: `c${i}`,
      })),
      () => (flip++ % 2 === 0 ? 0.2 : 0.8),
    );

    const set = await store.read("s");
    const first = set.items.filter((i) => i.presentedFirst === "baseline").length;
    expect(first).toBeGreaterThan(60);
    expect(first).toBeLessThan(140);
  });

  it("skips a pair it already holds", async () => {
    const store = new LabelStore(join(root, "labels"));
    const pair = { task: "t", baseline: "b", candidate: "c" };

    expect((await store.addItems("s", [pair])).added).toBe(1);
    const second = await store.addItems("s", [pair]);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("refuses to spend a human's attention on an identical pair", async () => {
    const store = new LabelStore(join(root, "labels"));
    const result = await store.addItems("s", [
      { task: "t", baseline: "same answer", candidate: "same answer" },
    ]);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("round-trips labels through disk", async () => {
    const store = new LabelStore(join(root, "labels"));
    await store.addItems("s", [{ task: "t", baseline: "b", candidate: "c" }]);

    const set = await store.read("s");
    expect(unlabelledItems(set)).toHaveLength(1);

    set.items[0]!.human = "candidate";
    set.items[0]!.labelledAt = 123;
    await store.write(set);

    const reloaded = await store.read("s");
    expect(labelledItems(reloaded)).toHaveLength(1);
    expect(reloaded.items[0]!.human).toBe("candidate");
  });
});

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

describe("calibration", () => {
  const setOf = (n: number, human: (i: number) => "baseline" | "candidate" | "tie") => ({
    name: "s",
    createdAt: 0,
    items: Array.from({ length: n }, (_, i) => ({
      id: `label_${i}`,
      task: `task ${i}`,
      baseline: `baseline ${i}`,
      candidate: `candidate ${i}`,
      presentedFirst: "baseline" as const,
      human: human(i),
      labelledAt: 1,
      caseId: null,
      baselineTraceId: null,
      candidateTraceId: null,
      baselineModel: null,
      candidateModel: null,
    })),
  });

  it("refuses to report kappa on too few labels", async () => {
    const judge = createJudge({ client: fakeClient(() => '{"winner":"TIE"}'), model: "fake" });
    await expect(
      calibrate({ set: setOf(5, () => "tie"), judge, judgeModel: "fake" }),
    ).rejects.toThrow(NotEnoughLabelsError);
    expect(MIN_LABELS).toBeGreaterThanOrEqual(30);
  });

  it("scores a perfect judge at kappa 1", async () => {
    const set = setOf(40, (i) => (i % 2 === 0 ? "baseline" : "candidate"));
    const judge: Judge = {
      judge: async (item) => ({
        winner: set.items.find((i) => i.id === item.id)!.human,
        reason: "matched",
        baselineShownAs: "A",
        raw: "",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        unparsed: false,
      }),
      measurePositionBias: async () => ({ flipped: false, verdicts: [] }),
    };

    const result = await calibrate({ set, judge, judgeModel: "fake", now: 1 });
    expect(result.kappa.kappa).toBeCloseTo(1, 6);
    expect(result.stored.n).toBe(40);
    expect(result.stored.judgeInputTokens).toBe(40);
  });

  it("scores a judge that always says tie at about zero, despite high raw agreement", async () => {
    // 70% of labels are ties, so raw agreement is 70% and means nothing.
    const set = setOf(40, (i) => (i < 28 ? "tie" : i < 34 ? "baseline" : "candidate"));
    const judge: Judge = {
      judge: async () => ({
        winner: "tie",
        reason: "",
        baselineShownAs: "A",
        raw: "",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        unparsed: false,
      }),
      measurePositionBias: async () => ({ flipped: false, verdicts: [] }),
    };

    const result = await calibrate({ set, judge, judgeModel: "fake", now: 1 });
    expect(result.kappa.observedAgreement).toBeCloseTo(0.7, 6);
    expect(result.kappa.kappa).toBeCloseTo(0, 6);
    expect(isTrustworthy(result.kappa.kappa)).toBe(false);
  });

  it("counts unreadable judge replies", async () => {
    const set = setOf(30, () => "tie");
    const judge = createJudge({
      client: fakeClient(() => "I cannot decide between these."),
      model: "fake",
    });

    const result = await calibrate({ set, judge, judgeModel: "fake", now: 1 });
    expect(result.unparsed).toBe(30);
    expect(result.stored.unparsedRate).toBe(1);
  });

  it("records the calibration for the report to cite", async () => {
    const store = new LabelStore(join(root, "labels"));
    const set = setOf(30, () => "tie");
    const judge = createJudge({ client: fakeClient(() => '{"winner":"TIE"}'), model: "fake" });

    const result = await calibrate({ set, judge, judgeModel: "qwen2.5:7b", now: 42 });
    await store.writeCalibration("s", result.stored);

    const stored = await store.readCalibration("s");
    expect(stored?.judgeModel).toBe("qwen2.5:7b");
    expect(stored?.createdAt).toBe(42);
    expect(stored?.n).toBe(30);
  });
});
