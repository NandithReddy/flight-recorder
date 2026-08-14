/**
 * Stubbed replay — playing tool responses back from a recording.
 *
 * This is the most defensible idea in the project. When a case regresses, the
 * first question is always "did the model get worse, or did the world change?"
 * — an API returned different data, a page moved, a rate limit hit. Nearly every
 * eval tool conflates the two and leaves you guessing.
 *
 * Running both modes answers it. If a case fails in stubbed mode, where the
 * environment is held perfectly still, the prompt or model got worse. If it only
 * fails live, something outside the agent changed.
 *
 * Matching is deliberately layered, because a candidate does not have to call
 * tools in the same way the baseline did — that divergence is itself the finding:
 *
 *   exact      same tool, byte-identical input       — full confidence
 *   positional same tool, different input            — the model asked differently
 *   miss       no recording for this call at all     — the model went somewhere new
 *   unused     the baseline called it, the candidate did not
 */

import { stableStringify } from "../core/ids.ts";
import type { ToolInterceptor } from "../recorder/recorder.ts";
import type { RunError, Trace } from "../core/types.ts";

export interface StubMiss {
  tool: string;
  input: unknown;
}

export interface StubReport {
  /** Served from a recording with byte-identical input. */
  exact: number;
  /** Served from a recording of the same tool called with different input. */
  positional: number;
  /** Calls the baseline never made; the candidate explored somewhere new. */
  misses: StubMiss[];
  /** Recorded calls the candidate never made. */
  unused: { tool: string; input: unknown }[];
  /** True when the candidate's tool use matched the baseline exactly. */
  identical: boolean;
}

export interface ReplayStub {
  interceptor: ToolInterceptor;
  report(): StubReport;
}

interface RecordedCall {
  tool: string;
  input: unknown;
  inputKey: string;
  output: unknown;
  /** The recording of a failure is still a recording of the environment. */
  error: RunError | null;
  used: boolean;
}

/**
 * The value a tool returns when the baseline has no recording for the call.
 *
 * Deliberately not an exception and deliberately not a fall-through to the real
 * tool. Throwing would abort the run and hide everything downstream; executing
 * for real would silently make this a live call and destroy the very property
 * stubbed mode exists to provide. Returning a legible marker lets the run
 * continue so we can see what the model does next, while the report records
 * that it happened.
 */
export function stubMissValue(tool: string): string {
  return `[stub miss] the recorded baseline never called ${tool} with these arguments`;
}

export function createReplayStub(baseline: Trace): ReplayStub {
  const recorded: RecordedCall[] = baseline.spans
    .filter((span) => span.kind === "tool")
    .map((span) => ({
      tool: span.name,
      input: span.input,
      inputKey: stableStringify(span.input),
      output: span.output,
      error: span.error,
      used: false,
    }));

  let exact = 0;
  let positional = 0;
  const misses: StubMiss[] = [];

  /**
   * Serving a recording means serving ALL of it. A tool call that failed on
   * the baseline must fail identically on replay — an agent that recovered
   * from the error live (LangGraph's ToolNode feeds it back to the model)
   * must see the same error text again, or the conversations silently diverge
   * while the report claims the environment was held still. Found by exactly
   * that happening: a recovered calculator error replayed as the string
   * "null" with success status.
   */
  const serve = (call: RecordedCall): unknown => {
    call.used = true;
    if (call.error) {
      const error = new Error(call.error.message);
      if (call.error.type) error.name = call.error.type;
      throw error;
    }
    return call.output;
  };

  const interceptor: ToolInterceptor = async ({ name, input }) => {
    const key = stableStringify(input);

    const exactMatch = recorded.find(
      (call) => !call.used && call.tool === name && call.inputKey === key,
    );
    if (exactMatch) {
      exact += 1;
      return serve(exactMatch);
    }

    const positionalMatch = recorded.find((call) => !call.used && call.tool === name);
    if (positionalMatch) {
      positional += 1;
      return serve(positionalMatch);
    }

    misses.push({ tool: name, input });
    return stubMissValue(name);
  };

  return {
    interceptor,
    report: () => {
      const unused = recorded
        .filter((call) => !call.used)
        .map((call) => ({ tool: call.tool, input: call.input }));
      return {
        exact,
        positional,
        misses,
        unused,
        identical: positional === 0 && misses.length === 0 && unused.length === 0,
      };
    },
  };
}
