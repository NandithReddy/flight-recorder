/**
 * The scoring ladder.
 *
 * Cheap and certain first, expensive and fallible last, with a hard stop in
 * between. A candidate that failed a deterministic assertion never reaches the
 * judge — there is nothing to deliberate about, and on a healthy suite this
 * early exit is what keeps judging a small fraction of the run rather than a
 * second full pass over everything.
 *
 * Every verdict says who decided it and how far that decider should be
 * trusted. A judged verdict carries the judge's current agreement with human
 * labels; below the threshold the report marks it untrusted rather than
 * presenting it as fact.
 */

import type { Assertion, TestCase, Trace, Verdict } from "../core/types.ts";
import { evaluateAll, type AssertionResult } from "../freeze/assertions.ts";
import { isTrustworthy } from "./kappa.ts";
import type { Judge, JudgeVerdict } from "./judge.ts";

export interface ScoreOptions {
  testCase: TestCase;
  candidate: Trace;
  /** The recording the judge compares against. Absent means tier 1 only. */
  baseline?: Trace | null;
  judge?: Judge | null;
  /** The judge's kappa from the latest calibration; null means uncalibrated. */
  trust?: number | null;
  /** Attempt id this verdict belongs to. */
  attemptId?: string;
}

export interface ScoreResult {
  verdict: Verdict;
  tier1: AssertionResult[];
  judgeVerdict: JudgeVerdict | null;
  /** True when a hard assertion failed and the judge was skipped. */
  earlyExit: boolean;
}

function outputOf(trace: Trace): string {
  return typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output ?? null);
}

/** Tier 1 alone: fast, free, and certain. */
export function scoreTier1(
  assertions: Assertion[],
  trace: Trace,
): { results: AssertionResult[]; hardFailures: AssertionResult[]; pass: boolean } {
  const results = evaluateAll(assertions, trace);
  const hardFailures = results.filter((r) => !r.pass && r.assertion.hard);
  return { results, hardFailures, pass: hardFailures.length === 0 };
}

export async function score(options: ScoreOptions): Promise<ScoreResult> {
  const { testCase, candidate } = options;
  const attemptId = options.attemptId ?? "";

  const tier1 = scoreTier1(testCase.assertions, candidate);

  if (!tier1.pass) {
    return {
      verdict: {
        attemptId,
        pass: false,
        score: 0,
        reason: tier1.hardFailures
          .map((r) => `${r.assertion.kind}(${r.assertion.value}): ${r.detail}`)
          .join("; "),
        decidedBy: "deterministic",
        // A deterministic verdict is not an opinion, so it has no trust caveat.
        trust: null,
        failedAssertionIds: tier1.hardFailures.map((r) => r.assertion.id),
      },
      tier1: tier1.results,
      judgeVerdict: null,
      earlyExit: true,
    };
  }

  const softFailures = tier1.results.filter((r) => !r.pass);

  // No judge, no baseline, or nothing to judge on — tier 1 is the whole verdict.
  if (!options.judge || !options.baseline) {
    return {
      verdict: {
        attemptId,
        pass: true,
        score: 1,
        reason:
          softFailures.length > 0
            ? `passed all hard assertions; ${softFailures.length} soft warnings`
            : "passed all assertions",
        decidedBy: "deterministic",
        trust: null,
        failedAssertionIds: softFailures.map((r) => r.assertion.id),
      },
      tier1: tier1.results,
      judgeVerdict: null,
      earlyExit: false,
    };
  }

  const judgeVerdict = await options.judge.judge({
    id: `${testCase.id}:${candidate.id}`,
    task: typeof testCase.input === "string" ? testCase.input : JSON.stringify(testCase.input),
    baseline: outputOf(options.baseline),
    candidate: outputOf(candidate),
    rubric: testCase.rubric,
  });

  // A regression harness asks "is this worse", not "is this best". A tie is a
  // pass: the candidate did not make anything worse.
  const scoreValue =
    judgeVerdict.winner === "candidate" ? 1 : judgeVerdict.winner === "tie" ? 0.5 : 0;
  const trust = options.trust ?? null;

  return {
    verdict: {
      attemptId,
      pass: judgeVerdict.winner !== "baseline",
      score: scoreValue,
      reason: judgeVerdict.unparsed
        ? "judge reply was unreadable; counted as a tie"
        : `judge preferred ${judgeVerdict.winner}: ${judgeVerdict.reason}`,
      decidedBy: "judge",
      trust,
      failedAssertionIds: softFailures.map((r) => r.assertion.id),
    },
    tier1: tier1.results,
    judgeVerdict,
    earlyExit: false,
  };
}

/** Whether a verdict should be presented as fact or flagged in the report. */
export function isVerdictTrusted(verdict: Verdict): boolean {
  if (verdict.decidedBy === "deterministic") return true;
  return verdict.trust !== null && isTrustworthy(verdict.trust);
}
