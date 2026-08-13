/**
 * Assembling a report.
 *
 * Two decisions shape everything here.
 *
 * **The comparison is paired.** Every case is run under both configs, so the
 * unit of resampling is the *case*, not the observation. Treating 40 baseline
 * results and 40 candidate results as two independent samples throws away the
 * pairing and widens every interval for no reason — and on a suite where some
 * cases are simply harder than others, that pairing is most of the signal.
 *
 * **Quality, cost and latency are reported together, never separately.** This
 * project's own evidence is that resource metrics prefer the broken agent: the
 * degraded mock is 33% cheaper, and a 3B model that fabricates its numbers is
 * 4.6x faster than the one that looks them up. A report that leads with cost
 * would recommend the wrong thing every time.
 */

import { bootstrap, type Interval } from "../stats/bootstrap.ts";
import { score, isVerdictTrusted } from "../score/scorer.ts";
import type { Judge } from "../score/judge.ts";
import type { SuiteFile } from "../freeze/suite.ts";
import type { SqliteTraceStore } from "../store/sqlite-store.ts";
import type { ReplayMode, RunConfig, TestCase, Trace, Verdict } from "../core/types.ts";

export interface CaseOutcome {
  caseId: string;
  task: string;
  before: { pass: boolean; costUsd: number; wallMs: number; traceId: string; output: string };
  after: { pass: boolean; costUsd: number; wallMs: number; traceId: string; output: string };
  /** Passed on the baseline, fails now. The only kind that gates a merge. */
  regressed: boolean;
  /** Failed on the baseline, passes now. */
  fixed: boolean;
  verdict: Verdict;
  trusted: boolean;
  tags: string[];
}

export interface ReportData {
  createdAt: number;
  suite: string;
  mode: ReplayMode;
  baseline: { configId: string; model: string; promptVersion: string };
  candidate: { configId: string; model: string; promptVersion: string };

  n: number;
  /** Cases in the suite with no usable pair under these configs. */
  missing: number;

  passRateBefore: number;
  passRateAfter: number;
  passRateDelta: Interval;

  costPerTaskBefore: number;
  costPerTaskAfter: number;
  costDelta: Interval;

  latencyP50Before: number;
  latencyP50After: number;
  latencyP95Before: number;
  latencyP95After: number;
  latencyP95Delta: Interval;

  judge: { model: string; kappa: number | null; trusted: boolean } | null;
  /** Judged verdicts whose judge is not trustworthy enough to present as fact. */
  untrustedVerdicts: number;

  cases: CaseOutcome[];
  regressions: CaseOutcome[];
  fixes: CaseOutcome[];
}

export interface BuildReportOptions {
  suite: SuiteFile;
  store: SqliteTraceStore;
  baselineConfig: RunConfig;
  candidateConfig: RunConfig;
  mode?: ReplayMode;
  /**
   * Where the baseline side comes from.
   *
   * `fresh` (default) prefers a run of the baseline config made in this
   * session — right when comparing two models, since both sides should be
   * measured the same way.
   *
   * `committed` forces the frozen reference the case was created from. This is
   * what a CI gate wants: if a change makes the baseline and the candidate
   * *equally* worse, a fresh-versus-fresh delta is zero and the regression
   * sails through. Comparing against the committed reference catches it.
   */
  baselineSource?: "fresh" | "committed";
  judge?: Judge | null;
  judgeModel?: string;
  /** Judge kappa from the last calibration; null means uncalibrated. */
  trust?: number | null;
  iterations?: number;
  now?: number;
}

export function percentileOf(values: number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (index - lower) * (sorted[upper]! - sorted[lower]!);
}

const mean = (values: number[]): number =>
  values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;

function outputOf(trace: Trace): string {
  return typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output ?? null);
}

async function traceFor(
  store: SqliteTraceStore,
  testCase: TestCase,
  configId: string,
  mode: ReplayMode,
): Promise<Trace | null> {
  const attempt = store.findAttempt(testCase.id, configId, mode);
  if (!attempt || attempt.traceId === "") return null;
  return store.get(attempt.traceId);
}

export async function buildReport(options: BuildReportOptions): Promise<ReportData> {
  const mode = options.mode ?? "live";
  const iterations = options.iterations ?? 10_000;

  const outcomes: CaseOutcome[] = [];
  let missing = 0;

  for (const testCase of options.suite.cases) {
    const beforeTrace =
      options.baselineSource === "committed"
        ? await options.store.get(testCase.baselineTraceId)
        : ((await traceFor(options.store, testCase, options.baselineConfig.id, mode)) ??
          (await options.store.get(testCase.baselineTraceId)));
    const afterTrace = await traceFor(options.store, testCase, options.candidateConfig.id, mode);

    if (!beforeTrace || !afterTrace) {
      missing += 1;
      continue;
    }

    const beforeScored = await score({
      testCase,
      candidate: beforeTrace,
      baseline: beforeTrace,
      attemptId: beforeTrace.id,
    });
    const afterScored = await score({
      testCase,
      candidate: afterTrace,
      baseline: beforeTrace,
      judge: options.judge ?? null,
      trust: options.trust ?? null,
      attemptId: afterTrace.id,
    });

    const before = beforeScored.verdict.pass;
    const after = afterScored.verdict.pass;

    outcomes.push({
      caseId: testCase.id,
      task: typeof testCase.input === "string" ? testCase.input : JSON.stringify(testCase.input),
      before: {
        pass: before,
        costUsd: beforeTrace.totals.costUsd,
        wallMs: beforeTrace.totals.wallMs,
        traceId: beforeTrace.id,
        output: outputOf(beforeTrace),
      },
      after: {
        pass: after,
        costUsd: afterTrace.totals.costUsd,
        wallMs: afterTrace.totals.wallMs,
        traceId: afterTrace.id,
        output: outputOf(afterTrace),
      },
      regressed: before && !after,
      fixed: !before && after,
      verdict: afterScored.verdict,
      trusted: isVerdictTrusted(afterScored.verdict),
      tags: testCase.tags,
    });
  }

  // Resample cases, not observations — the design is paired.
  const seed = `${options.suite.name}:${options.baselineConfig.id}:${options.candidateConfig.id}`;
  const passRateDelta = bootstrap(
    outcomes,
    (resample) =>
      (mean(resample.map((o) => (o.after.pass ? 1 : 0))) -
        mean(resample.map((o) => (o.before.pass ? 1 : 0)))) *
      100,
    { iterations, seed },
  );

  const costDelta = bootstrap(
    outcomes,
    (resample) =>
      mean(resample.map((o) => o.after.costUsd)) - mean(resample.map((o) => o.before.costUsd)),
    { iterations, seed: `${seed}:cost` },
  );

  const latencyP95Delta = bootstrap(
    outcomes,
    (resample) =>
      percentileOf(
        resample.map((o) => o.after.wallMs),
        0.95,
      ) -
      percentileOf(
        resample.map((o) => o.before.wallMs),
        0.95,
      ),
    { iterations, seed: `${seed}:latency` },
  );

  const judged = outcomes.filter((o) => o.verdict.decidedBy === "judge");

  return {
    createdAt: options.now ?? Date.now(),
    suite: options.suite.name,
    mode,
    baseline: {
      configId: options.baselineConfig.id,
      model: options.baselineConfig.model,
      promptVersion: options.baselineConfig.promptVersion,
    },
    candidate: {
      configId: options.candidateConfig.id,
      model: options.candidateConfig.model,
      promptVersion: options.candidateConfig.promptVersion,
    },

    n: outcomes.length,
    missing,

    passRateBefore: mean(outcomes.map((o) => (o.before.pass ? 1 : 0))) * 100,
    passRateAfter: mean(outcomes.map((o) => (o.after.pass ? 1 : 0))) * 100,
    passRateDelta,

    costPerTaskBefore: mean(outcomes.map((o) => o.before.costUsd)),
    costPerTaskAfter: mean(outcomes.map((o) => o.after.costUsd)),
    costDelta,

    latencyP50Before: percentileOf(outcomes.map((o) => o.before.wallMs), 0.5),
    latencyP50After: percentileOf(outcomes.map((o) => o.after.wallMs), 0.5),
    latencyP95Before: percentileOf(outcomes.map((o) => o.before.wallMs), 0.95),
    latencyP95After: percentileOf(outcomes.map((o) => o.after.wallMs), 0.95),
    latencyP95Delta,

    judge: options.judge
      ? {
          model: options.judgeModel ?? "unknown",
          kappa: options.trust ?? null,
          trusted: judged.length > 0 && judged.every((o) => o.trusted),
        }
      : null,
    untrustedVerdicts: judged.filter((o) => !o.trusted).length,

    cases: outcomes,
    regressions: outcomes.filter((o) => o.regressed),
    fixes: outcomes.filter((o) => o.fixed),
  };
}

/**
 * The single line a human reads first.
 *
 * Deliberately refuses to lead with a direction when the interval spans zero.
 * "Pass rate fell 5%" and "pass rate moved 5%, which is indistinguishable from
 * noise at this sample size" are different claims, and only one of them is
 * supported by 40 cases.
 */
export function headline(report: ReportData): string {
  const delta = report.passRateDelta;
  if (report.n === 0) return "No comparable cases — nothing to report.";

  if (!delta.significant) {
    return (
      `No detectable change in pass rate: ${delta.point >= 0 ? "+" : ""}${delta.point.toFixed(1)}% ` +
      `(${delta.lower.toFixed(1)}% to ${delta.upper.toFixed(1)}%), not significant at n=${report.n}.`
    );
  }

  const direction = delta.point < 0 ? "fell" : "rose";
  return (
    `Pass rate ${direction} ${Math.abs(delta.point).toFixed(1)}% ` +
    `(${delta.lower.toFixed(1)}% to ${delta.upper.toFixed(1)}%, 95% CI, n=${report.n}).`
  );
}
