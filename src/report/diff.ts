/**
 * Where two runs stopped agreeing.
 *
 * A regression report that says "this case failed" sends you to read two full
 * traces. One that says "they agreed for three steps, then the candidate called
 * `calculate` where the baseline called `search`" sends you to the line that
 * matters. The diverging step is almost always the whole explanation.
 */

import { stableStringify } from "../core/ids.ts";
import type { Span, Trace } from "../core/types.ts";

export type StepStatus = "same" | "changed" | "only-baseline" | "only-candidate";

export interface StepSide {
  kind: string;
  /** What the step *is*, for comparison. Model spans are all just "model". */
  name: string;
  /** Which model or tool actually ran, for display only. */
  detail: string;
  output: string;
  ms: number;
}

export interface StepDiff {
  index: number;
  status: StepStatus;
  baseline: StepSide | null;
  candidate: StepSide | null;
}

export interface TraceDiff {
  steps: StepDiff[];
  /** Index of the first step that differs, or null when the runs match. */
  divergedAt: number | null;
  /** One sentence naming what changed at that step. */
  summary: string;
}

/**
 * Reduces a span to the part worth comparing.
 *
 * A model span is compared by the *decision* it produced — which tools it asked
 * for — not by the model's name or its prose. Comparing model names makes every
 * step differ the moment you change models, which is precisely the comparison
 * the report exists to make, so the diff would say nothing. Comparing the prose
 * is no better: two correct answers rarely share wording, and the answers are
 * already shown side by side above the diff.
 *
 * What is left is the path the agent took, which is the part that explains a
 * regression.
 */
function sideOf(span: Span): StepSide {
  if (span.kind === "model") {
    const output = span.output as { toolCalls?: { name: string }[] } | null;
    const calls = (output?.toolCalls ?? []).map((call) => call.name);
    return {
      kind: "model",
      name: "model",
      detail: span.name,
      output: calls.length > 0 ? `asked for ${calls.join(", ")}` : "answered",
      ms: span.endedAt - span.startedAt,
    };
  }

  return {
    kind: "tool",
    name: span.name,
    detail: span.name,
    output: typeof span.output === "string" ? span.output : stableStringify(span.output ?? null),
    ms: span.endedAt - span.startedAt,
  };
}

export function diffTraces(baseline: Trace, candidate: Trace): TraceDiff {
  const left = baseline.spans;
  const right = candidate.spans;
  const steps: StepDiff[] = [];
  let divergedAt: number | null = null;

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i];
    const b = right[i];

    if (a && !b) {
      steps.push({ index: i, status: "only-baseline", baseline: sideOf(a), candidate: null });
      divergedAt ??= i;
      continue;
    }
    if (!a && b) {
      steps.push({ index: i, status: "only-candidate", baseline: null, candidate: sideOf(b) });
      divergedAt ??= i;
      continue;
    }
    if (!a || !b) continue;

    const sideA = sideOf(a);
    const sideB = sideOf(b);
    // Same step means the same call producing the same thing. Timing is not
    // part of it — wall time varies on every run and is not a divergence.
    const same =
      a.kind === b.kind && a.name === b.name && sideA.output === sideB.output;
    if (!same) divergedAt ??= i;

    steps.push({
      index: i,
      status: same ? "same" : "changed",
      baseline: sideA,
      candidate: sideB,
    });
  }

  return { steps, divergedAt, summary: summarise(steps, divergedAt) };
}

function summarise(steps: StepDiff[], divergedAt: number | null): string {
  if (divergedAt === null) return "Both runs took identical steps.";

  const step = steps[divergedAt];
  if (!step) return "The runs diverge.";

  const prefix =
    divergedAt === 0
      ? "The runs diverge immediately"
      : `The runs agree for ${divergedAt} step${divergedAt === 1 ? "" : "s"}, then diverge`;

  const describe = (side: StepSide) =>
    side.kind === "model" ? side.output : `called ${side.name}`;

  if (step.status === "only-baseline") {
    return `${prefix}: the baseline ${describe(step.baseline!)} and the candidate stopped.`;
  }
  if (step.status === "only-candidate") {
    return `${prefix}: the candidate ${describe(step.candidate!)}, which the baseline never did.`;
  }
  if (step.baseline!.name !== step.candidate!.name) {
    return `${prefix}: the baseline ${describe(step.baseline!)}, the candidate ${describe(step.candidate!)}.`;
  }
  if (step.baseline!.kind === "model") {
    return `${prefix}: the baseline ${step.baseline!.output}, the candidate ${step.candidate!.output}.`;
  }
  return `${prefix}: both called ${step.baseline!.name}, but it returned something different.`;
}
