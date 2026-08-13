/**
 * Freezing — promoting a recording into a fixture.
 *
 * The whole design goal is that this takes ninety seconds, not fifteen minutes.
 * The proposer does the writing; the human does the deciding. What arrives here
 * is a trace and a set of decisions, and what leaves is a TestCase.
 */

import { newId } from "../core/ids.ts";
import type { Assertion, TestCase, Trace } from "../core/types.ts";
import {
  evaluateAll,
  proposeAssertions,
  type AssertionProposal,
  type ProposeOptions,
} from "./assertions.ts";

export interface FreezeOptions {
  trace: Trace;
  tags?: string[];
  /** Optional tier-2 rubric. Absent means deterministic checks only. */
  rubric?: string | null;
  /** Indices of proposals to leave out, as printed by the CLI (1-based). */
  drop?: number[];
  /** Replaces the default proposals entirely. */
  assertions?: Assertion[];
  propose?: ProposeOptions;
  /** Timestamp, injected so tests are deterministic. */
  now?: number;
}

export interface FreezeResult {
  testCase: TestCase;
  proposals: AssertionProposal[];
  dropped: AssertionProposal[];
}

export class InvalidProposalError extends Error {
  readonly failures: string[];

  constructor(failures: string[]) {
    super(
      "The proposer produced assertions that do not hold on the trace they came " +
        `from, which is a bug in the proposer, not in your agent:\n  ${failures.join("\n  ")}`,
    );
    this.name = "InvalidProposalError";
    this.failures = failures;
  }
}

/**
 * Turns a trace into a TestCase.
 *
 * Every assertion is checked against its source trace before the case is
 * returned. A proposal that fails there can only mean the proposer is wrong,
 * and shipping a case whose baseline does not pass would poison every report
 * built on it.
 */
export function freeze(options: FreezeOptions): FreezeResult {
  const { trace } = options;

  const proposals = proposeAssertions(trace, options.propose ?? {});
  const dropIndices = new Set(options.drop ?? []);
  const kept: AssertionProposal[] = [];
  const dropped: AssertionProposal[] = [];

  proposals.forEach((proposal, index) => {
    if (dropIndices.has(index + 1)) dropped.push(proposal);
    else kept.push(proposal);
  });

  const assertions = options.assertions ?? kept.map((proposal) => proposal.assertion);

  const failures = evaluateAll(assertions, trace)
    .filter((result) => !result.pass)
    .map((result) => `${result.assertion.kind}(${result.assertion.value}): ${result.detail}`);
  if (failures.length > 0) throw new InvalidProposalError(failures);

  const testCase: TestCase = {
    id: newId("case"),
    agent: trace.agent,
    sourceTraceId: trace.id,
    input: trace.input,
    assertions,
    rubric: options.rubric ?? null,
    // The trace we froze from is also the output the judge compares against.
    baselineTraceId: trace.id,
    tags: options.tags ?? [],
    createdAt: options.now ?? Date.now(),
  };

  return { testCase, proposals, dropped };
}
