/**
 * A deterministic, zero-cost model client.
 *
 * Phase 0 runs the entire capture -> store -> replay loop without an API key
 * and without spending anything. It also lets us induce a regression on
 * demand, which is the behaviour the whole harness exists to catch: the
 * `degraded` variant does not get worse in any way that throws. It skips a
 * verification step and answers confidently with an unchecked number.
 */

import type {
  GenerateRequest,
  GenerateResponse,
  ModelClient,
} from "./types.ts";

export type MockQuality = "good" | "degraded";

export interface MockClientOptions {
  quality?: MockQuality;
  /** Simulated per-call latency, so wall-time totals are non-trivial. */
  latencyMs?: number;
}

// Synthetic prices, in USD per million tokens. Real adapters carry real ones.
const PRICE_IN = 3.0;
const PRICE_OUT = 15.0;

function estimateTokens(text: string): number {
  // Deliberately crude and deterministic; real adapters report true counts.
  return Math.max(1, Math.ceil(text.length / 4));
}

function usageFor(request: GenerateRequest, output: string) {
  const inputTokens = request.messages.reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0,
  );
  const outputTokens = estimateTokens(output);
  return {
    inputTokens,
    outputTokens,
    costUsd:
      (inputTokens / 1_000_000) * PRICE_IN +
      (outputTokens / 1_000_000) * PRICE_OUT,
  };
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

export function createMockClient(options: MockClientOptions = {}): ModelClient {
  const quality = options.quality ?? "good";
  const latencyMs = options.latencyMs ?? 5;

  return {
    providerId: `mock:${quality}`,

    async generate(request: GenerateRequest): Promise<GenerateResponse> {
      await sleep(latencyMs);

      // Turn number = how many assistant messages are already in the thread.
      const turn = request.messages.filter((m) => m.role === "assistant").length;

      if (turn === 0) {
        const text = "I need the current figures before I can answer.";
        return {
          text,
          toolCalls: [
            {
              id: "call_search_1",
              name: "search",
              input: { query: "quarterly active users" },
            },
          ],
          usage: usageFor(request, text),
          finishReason: "tool_use",
        };
      }

      if (turn === 1) {
        if (quality === "degraded") {
          // The regression: skips verification, answers anyway, sounds fine.
          const text =
            "Active users grew by roughly 25% quarter over quarter, " +
            "from 1.2M to about 1.5M.";
          return {
            text,
            toolCalls: [],
            usage: usageFor(request, text),
            finishReason: "stop",
          };
        }

        const text = "Now I will compute the exact growth rate.";
        return {
          text,
          toolCalls: [
            {
              id: "call_calc_1",
              name: "calculate",
              input: { expression: "(1420000 - 1200000) / 1200000 * 100" },
            },
          ],
          usage: usageFor(request, text),
          finishReason: "tool_use",
        };
      }

      const last = request.messages.at(-1);
      const computed = last?.role === "tool" ? last.content : "unknown";
      const text =
        `Active users grew ${computed}% quarter over quarter, ` +
        `from 1,200,000 to 1,420,000.`;
      return {
        text,
        toolCalls: [],
        usage: usageFor(request, text),
        finishReason: "stop",
      };
    },
  };
}
