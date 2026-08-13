/**
 * The gate — turning a report into a merge decision.
 *
 * Four conditions, and the reasoning behind each matters more than the code:
 *
 *   - **A statistically significant pass-rate drop.** Significant, not merely
 *     negative. Blocking on an insignificant dip trains people to override the
 *     gate, and a gate that gets overridden by habit protects nothing.
 *   - **Any `p0` case regressing at all.** Some cases are load-bearing enough
 *     that one failure is a failure, whatever the aggregate says. Statistics
 *     are the wrong tool for "the billing flow broke".
 *   - **Cost per task above a ceiling.**
 *   - **p95 latency above a ceiling.**
 *
 * Untrusted verdicts never block. If the judge is not calibrated well enough to
 * present as fact, it is not calibrated well enough to fail someone's build —
 * the report says so and a human decides.
 */

import type { CaseOutcome, ReportData } from "../report/build.ts";

export interface GateThresholds {
  /** Tag that makes a single regression fatal. Default "p0". */
  criticalTag?: string;
  /** Fail if cost per task exceeds this. */
  maxCostPerTaskUsd?: number;
  /** Fail if p95 latency exceeds this. */
  maxLatencyP95Ms?: number;
  /** Fail on a significant pass-rate drop. Default true. */
  failOnPassRateDrop?: boolean;
  /**
   * Fail on *any* regression, significant or not. Off by default: on a small
   * suite that is a coin flip, and a gate that fires on noise gets disabled.
   */
  failOnAnyRegression?: boolean;
}

export type GateStatus = "pass" | "fail";

export interface GateFinding {
  rule: string;
  failed: boolean;
  detail: string;
  /** Cases responsible, where the rule is about specific ones. */
  cases: string[];
}

export interface GateResult {
  status: GateStatus;
  findings: GateFinding[];
  /** Findings that failed, in the order they should be read. */
  failures: GateFinding[];
  /** Verdicts excluded from the decision because the judge is untrusted. */
  ignoredUntrusted: number;
  exitCode: 0 | 1;
}

function criticalRegressions(report: ReportData, tag: string): CaseOutcome[] {
  return report.regressions.filter((outcome) => outcome.tags.includes(tag));
}

export function evaluateGate(report: ReportData, thresholds: GateThresholds = {}): GateResult {
  const criticalTag = thresholds.criticalTag ?? "p0";
  const findings: GateFinding[] = [];

  // Only trusted verdicts can fail a build. An uncalibrated judge gets a say in
  // the report, never in the decision.
  const trustedRegressions = report.regressions.filter((outcome) => outcome.trusted);
  const ignoredUntrusted = report.regressions.length - trustedRegressions.length;

  const drop = thresholds.failOnPassRateDrop ?? true;
  const passRateFailed =
    drop && report.passRateDelta.significant && report.passRateDelta.point < 0;
  findings.push({
    rule: "pass-rate",
    failed: passRateFailed,
    detail: report.passRateDelta.significant
      ? `${report.passRateDelta.point >= 0 ? "+" : ""}${report.passRateDelta.point.toFixed(1)}% ` +
        `(${report.passRateDelta.lower.toFixed(1)}% to ${report.passRateDelta.upper.toFixed(1)}%)`
      : `${report.passRateDelta.point >= 0 ? "+" : ""}${report.passRateDelta.point.toFixed(1)}%, ` +
        `not significant at n=${report.n} — not blocking on noise`,
    cases: [],
  });

  const critical = criticalRegressions(report, criticalTag).filter((o) => o.trusted);
  findings.push({
    rule: `${criticalTag}-regression`,
    failed: critical.length > 0,
    detail:
      critical.length > 0
        ? `${critical.length} case(s) tagged ${criticalTag} regressed`
        : `no ${criticalTag} case regressed`,
    cases: critical.map((o) => o.caseId),
  });

  if (thresholds.failOnAnyRegression) {
    findings.push({
      rule: "any-regression",
      failed: trustedRegressions.length > 0,
      detail: `${trustedRegressions.length} regression(s)`,
      cases: trustedRegressions.map((o) => o.caseId),
    });
  }

  if (thresholds.maxCostPerTaskUsd !== undefined) {
    const over = report.costPerTaskAfter > thresholds.maxCostPerTaskUsd;
    findings.push({
      rule: "cost-ceiling",
      failed: over,
      detail: `$${report.costPerTaskAfter.toFixed(6)} per task (ceiling $${thresholds.maxCostPerTaskUsd.toFixed(6)})`,
      cases: [],
    });
  }

  if (thresholds.maxLatencyP95Ms !== undefined) {
    const over = report.latencyP95After > thresholds.maxLatencyP95Ms;
    findings.push({
      rule: "latency-ceiling",
      failed: over,
      detail: `p95 ${Math.round(report.latencyP95After)}ms (ceiling ${thresholds.maxLatencyP95Ms}ms)`,
      cases: [],
    });
  }

  const failures = findings.filter((f) => f.failed);
  return {
    status: failures.length > 0 ? "fail" : "pass",
    findings,
    failures,
    ignoredUntrusted,
    exitCode: failures.length > 0 ? 1 : 0,
  };
}

/** A compact summary suitable for a CI log or a pull-request comment. */
export function formatGate(report: ReportData, result: GateResult): string {
  const lines: string[] = [];
  lines.push(
    `${result.status === "pass" ? "PASS" : "FAIL"} — ${report.baseline.model} → ${report.candidate.model}, ` +
      `${report.n} cases, ${report.mode} mode`,
  );
  for (const finding of result.findings) {
    lines.push(`  ${finding.failed ? "✗" : "✓"} ${finding.rule.padEnd(20)} ${finding.detail}`);
  }
  if (result.ignoredUntrusted > 0) {
    lines.push(
      `  · ${result.ignoredUntrusted} regression(s) ignored: the judge that flagged them ` +
        `is not calibrated well enough to block a build.`,
    );
  }
  return lines.join("\n");
}
