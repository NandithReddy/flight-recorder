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
import type { Trace } from "../core/types.ts";

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
      used: false,
    }));

  let exact = 0;
  let positional = 0;
  const misses: StubMiss[] = [];

  const interceptor: ToolInterceptor = async ({ name, input }) => {
    const key = stableStringify(input);

    const exactMatch = recorded.find(
      (call) => !call.used && call.tool === name && call.inputKey === key,
    );
    if (exactMatch) {
      exactMatch.used = true;
      exact += 1;
      return exactMatch.output;
    }

    const positionalMatch = recorded.find((call) => !call.used && call.tool === name);
    if (positionalMatch) {
      positionalMatch.used = true;
      positional += 1;
      return positionalMatch.output;
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
