/**
 * Assertion proposal and evaluation.
 *
 * The proposer is the component that decides whether anyone ever uses this
 * tool. Hand-writing fifty test cases is the reason eval tooling sits unused,
 * so a case has to be something you accept in ninety seconds rather than
 * something you author.
 *
 * The evaluator lives here rather than in the scorer because the proposer needs
 * it: an assertion proposed from a trace that does not hold on that same trace
 * is a bug, and the only way to know is to run it. Phase 4's tiered scorer is
 * built on top of this, not beside it.
 */

import { newId } from "../core/ids.ts";
import type { Assertion, Span, Trace } from "../core/types.ts";

export interface AssertionProposal {
  assertion: Assertion;
  /**
   * How safe this is to accept unread. `high` means the assertion restates
   * something the trace directly demonstrates; `medium` means a threshold was
   * chosen with headroom and you may want a different one.
   */
  confidence: "high" | "medium";
  rationale: string;
}

export interface AssertionResult {
  assertion: Assertion;
  pass: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function outputText(trace: Trace): string {
  return typeof trace.output === "string" ? trace.output : JSON.stringify(trace.output ?? null);
}

function toolNames(trace: Trace): string[] {
  return trace.spans.filter((s) => s.kind === "tool").map((s) => s.name);
}

export function evaluateAssertion(assertion: Assertion, trace: Trace): AssertionResult {
  const pass = (ok: boolean, detail: string): AssertionResult => ({ assertion, pass: ok, detail });
  const text = outputText(trace);

  switch (assertion.kind) {
    case "no_error":
      return pass(trace.error === null, trace.error ? trace.error.message : "no error");

    case "tool_called": {
      const called = toolNames(trace);
      return pass(
        called.includes(String(assertion.value)),
        called.length ? `called: ${called.join(", ")}` : "no tools were called",
      );
    }

    case "tool_not_called": {
      const called = toolNames(trace);
      return pass(!called.includes(String(assertion.value)), `called: ${called.join(", ") || "none"}`);
    }

    case "max_steps":
      return pass(
        trace.totals.steps <= Number(assertion.value),
        `${trace.totals.steps} steps (limit ${assertion.value})`,
      );

    case "max_cost_usd":
      return pass(
        trace.totals.costUsd <= Number(assertion.value),
        `$${trace.totals.costUsd.toFixed(6)} (limit $${Number(assertion.value).toFixed(6)})`,
      );

    case "max_wall_ms":
      return pass(
        trace.totals.wallMs <= Number(assertion.value),
        `${trace.totals.wallMs}ms (limit ${assertion.value}ms)`,
      );

    case "output_contains":
      return pass(
        text.includes(String(assertion.value)),
        text.includes(String(assertion.value))
          ? `found "${assertion.value}"`
          : `"${assertion.value}" absent from the output`,
      );

    case "output_matches": {
      let regex: RegExp;
      try {
        regex = new RegExp(String(assertion.value));
      } catch {
        return pass(false, `invalid pattern: ${assertion.value}`);
      }
      return pass(regex.test(text), regex.test(text) ? "matched" : "no match");
    }

    case "output_json_valid": {
      if (trace.output !== null && typeof trace.output === "object") {
        return pass(true, "output is structured");
      }
      try {
        JSON.parse(text);
        return pass(true, "parsed as JSON");
      } catch (error) {
        return pass(false, error instanceof Error ? error.message : "not JSON");
      }
    }
  }
}

export function evaluateAll(assertions: Assertion[], trace: Trace): AssertionResult[] {
  return assertions.map((assertion) => evaluateAssertion(assertion, trace));
}

// ---------------------------------------------------------------------------
// Output analysis — which claims the run actually verified
// ---------------------------------------------------------------------------

export interface OutputLiteral {
  value: string;
  /** The tool whose output also contained this literal, if any. */
  verifiedBy: string | null;
}

/**
 * Splits the literals in the final answer into those a tool actually produced
 * and those the model asserted on its own.
 *
 * This is the highest-signal thing we can compute from a trace without a judge.
 * A number in the answer that also appears in a tool result is a claim the run
 * checked; a number that appears nowhere else is a claim the model made up, and
 * that distinction is exactly the failure this harness exists to catch.
 */
export function analyzeOutput(trace: Trace): OutputLiteral[] {
  const text = outputText(trace);

  const candidates = new Set<string>();
  for (const match of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    // Single digits are too common to be evidence of anything.
    if (match[0].length >= 2) candidates.add(match[0]);
  }
  for (const match of text.matchAll(/"([^"]{3,60})"/g)) {
    if (match[1]) candidates.add(match[1]);
  }

  const toolOutputs: { name: string; text: string }[] = trace.spans
    .filter((span: Span) => span.kind === "tool")
    .map((span) => ({
      name: span.name,
      text: typeof span.output === "string" ? span.output : JSON.stringify(span.output ?? null),
    }));

  return [...candidates].map((value) => ({
    value,
    // Deliberately an exact substring match. Normalising digits would make
    // "1.2" match inside "1,200,000" and manufacture verification that the run
    // never did — a false positive here is far worse than a false negative.
    verifiedBy: toolOutputs.find((tool) => tool.text.includes(value))?.name ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export interface ProposeOptions {
  /** Headroom on the step ceiling. Default 1.25. */
  stepSlack?: number;
  /** Headroom on the cost ceiling. Default 1.5. */
  costSlack?: number;
  /** Headroom on the wall-clock ceiling. Default 3 — wall time is noisy. */
  wallSlack?: number;
  /** Cap on how many verified literals become assertions. Default 5. */
  maxLiterals?: number;
}

function assertion(
  kind: Assertion["kind"],
  value: string | number,
  hard: boolean,
  note: string,
): Assertion {
  return { id: newId("assert"), kind, value, hard, note };
}

/**
 * Reads a trace and proposes the assertions a human would have written.
 *
 * Nothing here is accepted automatically — the caller decides. But the defaults
 * are chosen so that accepting all of them produces a case that is strict about
 * behaviour the run demonstrated and lenient about numbers that drift.
 */
export function proposeAssertions(
  trace: Trace,
  options: ProposeOptions = {},
): AssertionProposal[] {
  const stepSlack = options.stepSlack ?? 1.25;
  const costSlack = options.costSlack ?? 1.5;
  const wallSlack = options.wallSlack ?? 3;
  const maxLiterals = options.maxLiterals ?? 5;

  const proposals: AssertionProposal[] = [];

  if (trace.error === null) {
    proposals.push({
      assertion: assertion("no_error", 1, true, "the baseline run completed without error"),
      confidence: "high",
      rationale: "The run succeeded, so a future failure is a regression by definition.",
    });
  }

  for (const name of [...new Set(toolNames(trace))]) {
    proposals.push({
      assertion: assertion("tool_called", name, true, `the baseline called ${name}`),
      confidence: "high",
      rationale:
        `The run used ${name} to do its work. Skipping it later means the agent ` +
        "reached its answer a different way, which is worth failing on.",
    });
  }

  const verified = analyzeOutput(trace)
    .filter((literal) => literal.verifiedBy !== null)
    .slice(0, maxLiterals);

  for (const literal of verified) {
    proposals.push({
      assertion: assertion(
        "output_contains",
        literal.value,
        true,
        `"${literal.value}" was produced by ${literal.verifiedBy} and appears in the answer`,
      ),
      confidence: "high",
      rationale:
        `${literal.verifiedBy} produced "${literal.value}" and the final answer repeats it. ` +
        "That makes it a checked fact rather than a claim, so it is safe to pin.",
    });
  }

  if (trace.output !== null && typeof trace.output === "object") {
    proposals.push({
      assertion: assertion("output_json_valid", 1, true, "the baseline returned structured output"),
      confidence: "high",
      rationale: "The answer was structured, so unparseable output later is a regression.",
    });
  }

  proposals.push({
    assertion: assertion(
      "max_steps",
      Math.ceil(trace.totals.steps * stepSlack),
      true,
      `the baseline took ${trace.totals.steps} steps`,
    ),
    confidence: "medium",
    rationale:
      `Baseline was ${trace.totals.steps} steps; the ceiling adds ${Math.round(
        (stepSlack - 1) * 100,
      )}% headroom. Raise it if the task legitimately varies in length.`,
  });

  if (trace.totals.costUsd > 0) {
    proposals.push({
      assertion: assertion(
        "max_cost_usd",
        Number((trace.totals.costUsd * costSlack).toPrecision(3)),
        false,
        `the baseline cost $${trace.totals.costUsd.toFixed(6)}`,
      ),
      confidence: "medium",
      rationale:
        "Soft by default: a cost rise is worth reporting but is rarely worth failing a " +
        "build on its own. Make it hard if you have a budget to defend.",
    });
  }

  proposals.push({
    assertion: assertion(
      "max_wall_ms",
      Math.ceil(trace.totals.wallMs * wallSlack),
      false,
      `the baseline took ${trace.totals.wallMs}ms`,
    ),
    confidence: "medium",
    rationale:
      `Soft, and generous at ${wallSlack}x: wall time depends on the machine and the ` +
      "provider's load, so a tight bound here produces flaky failures rather than findings.",
  });

  return proposals;
}
