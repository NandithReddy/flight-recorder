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
  /** The tool whose grounded output contained this literal, if any. */
  verifiedBy: string | null;
}

export interface GroundingOptions {
  /**
   * Integers at or below this are treated as arithmetic scaffolding rather than
   * claims about the world — the `100` in a percentage, a `2` in a doubling.
   * Real metrics are larger; invented ones (`450`, `500`) are not exempt.
   */
  constantCeiling?: number;
}

/**
 * Canonical numeric form: `1,420,000` and `1420000` are the same number, and a
 * trailing separator belongs to the prose rather than the value.
 */
function normalizeNumber(token: string): string {
  return token.replace(/,+$/, "").replaceAll(",", "");
}

/**
 * Numbers appearing as whole tokens.
 *
 * Whole tokens, not substrings. Substring matching would let `1.2` match inside
 * `1,200,000` and certify a claim the run never made; comparing normalised
 * tokens catches the comma variants without inventing that match.
 */
function numberTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) out.add(normalizeNumber(match[0]));
  return out;
}

function isSubstantial(token: string, ceiling: number): boolean {
  const value = Math.abs(Number(token));
  if (Number.isNaN(value)) return true;
  return !Number.isInteger(value) || value > ceiling;
}

/**
 * Splits the literals in the final answer into those the run actually
 * established and those the model asserted on its own.
 *
 * Verification has to follow provenance, not just presence. A tool's output is
 * evidence only if the tool's own inputs were themselves grounded — otherwise
 * the tool faithfully computed something from numbers the model invented, and
 * its output launders a hallucination into an apparently checked fact.
 *
 * This is not hypothetical. A 3B model asked for quarterly growth skipped the
 * lookup entirely, called the calculator with `450` and `500`, and answered
 * "11.11%" — arithmetically correct, entirely fabricated, and indistinguishable
 * from a real answer to a presence-only check.
 */
export function analyzeOutput(trace: Trace, options: GroundingOptions = {}): OutputLiteral[] {
  const ceiling = options.constantCeiling ?? 100;
  const text = outputText(trace);

  const candidates = new Set<string>();
  for (const match of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    // Trailing separators belong to the prose, not the number ("450, and ...").
    const token = match[0].replace(/,+$/, "");
    // Single digits are too common to be evidence of anything.
    if (token.length >= 2) candidates.add(token);
  }
  for (const match of text.matchAll(/"([^"]{3,60})"/g)) {
    if (match[1]) candidates.add(match[1]);
  }

  // Anything in the question came from outside the model, so it is grounded.
  const grounded = new Map<string, string>();
  for (const token of numberTokens(outputTextOf(trace.input))) grounded.set(token, "input");

  const groundedText: { name: string; text: string }[] = [];

  for (const span of trace.spans) {
    if (span.kind !== "tool") continue;

    const inputText = outputTextOf(span.input);
    const outputStr = outputTextOf(span.output);

    // Every substantial number the model handed this tool must already be
    // grounded, or the tool is computing over invented values.
    const needed = [...numberTokens(inputText)].filter((token) =>
      isSubstantial(token, ceiling),
    );
    const isGrounded = needed.every((token) => grounded.has(token));
    if (!isGrounded) continue;

    for (const token of numberTokens(outputStr)) {
      if (!grounded.has(token)) grounded.set(token, span.name);
    }
    groundedText.push({ name: span.name, text: outputStr });
  }

  return [...candidates].map((value) => {
    const normalized = normalizeNumber(value);
    const byNumber = grounded.get(normalized);
    if (byNumber !== undefined && byNumber !== "input") return { value, verifiedBy: byNumber };

    // Non-numeric literals fall back to presence in a grounded tool output.
    if (byNumber === undefined && !/^\-?\d/.test(value)) {
      const source = groundedText.find((tool) => tool.text.includes(value));
      if (source) return { value, verifiedBy: source.name };
    }

    return { value, verifiedBy: null };
  });
}

function outputTextOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
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
