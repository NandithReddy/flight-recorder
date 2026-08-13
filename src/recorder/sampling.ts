/**
 * Sampling policy.
 *
 * Recording 100% of production traffic is neither affordable nor useful — most
 * runs are the same happy path. But the traces you actually want to freeze into
 * test cases are exactly the rare ones: the failures, and the ones a human
 * flagged. So the policy is "sample the boring, keep all the interesting".
 *
 * The decision is a hash of the trace id rather than a random draw, which makes
 * it reproducible: the same trace is always kept or always dropped, and the
 * tests can assert on real numbers instead of tolerating flake.
 */

import { sha256 } from "../core/ids.ts";
import type { Trace } from "../core/types.ts";

export interface SamplingOptions {
  /** 0 keeps nothing sampled, 1 keeps everything. Default 1. */
  rate?: number;
  /** Keep every run that errored, whatever the rate. Default true. */
  alwaysKeepErrors?: boolean;
  /** Keep any run carrying one of these tags. Default ["flagged"]. */
  alwaysKeepTags?: string[];
  /** Keep runs whose cost exceeds this, since outliers are worth studying. */
  alwaysKeepAboveCostUsd?: number;
}

export interface SamplingDecision {
  keep: boolean;
  /** Why — carried into logs so a missing trace is explainable. */
  reason: "error" | "tagged" | "cost-outlier" | "sampled-in" | "sampled-out";
}

export type Sampler = (trace: Trace) => SamplingDecision;

/** Maps a trace id into [0, 1) deterministically. */
export function bucketOf(traceId: string): number {
  // 52 bits keeps the value exactly representable as a double.
  const bits = Number.parseInt(sha256(traceId).slice(0, 13), 16);
  return bits / 2 ** 52;
}

export function createSampler(options: SamplingOptions = {}): Sampler {
  const rate = Math.min(1, Math.max(0, options.rate ?? 1));
  const alwaysKeepErrors = options.alwaysKeepErrors ?? true;
  const alwaysKeepTags = new Set(options.alwaysKeepTags ?? ["flagged"]);
  const costCeiling = options.alwaysKeepAboveCostUsd;

  return (trace: Trace): SamplingDecision => {
    if (alwaysKeepErrors && trace.error !== null) return { keep: true, reason: "error" };
    if (trace.tags.some((tag) => alwaysKeepTags.has(tag))) {
      return { keep: true, reason: "tagged" };
    }
    if (costCeiling !== undefined && trace.totals.costUsd > costCeiling) {
      return { keep: true, reason: "cost-outlier" };
    }
    return bucketOf(trace.id) < rate
      ? { keep: true, reason: "sampled-in" }
      : { keep: false, reason: "sampled-out" };
  };
}

/** The policy used when none is configured: keep everything. */
export const keepEverything: Sampler = createSampler({ rate: 1 });
