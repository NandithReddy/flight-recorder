/**
 * The recorder.
 *
 * Wraps the model client and the tools at the client boundary, appends spans,
 * and never blocks or scores anything. Phase 1 replaces the hand-rolled span
 * bookkeeping below with OpenTelemetry GenAI semantic conventions; the public
 * surface here is deliberately the one an OTel-backed implementation can keep.
 */

import { newId } from "../core/ids.ts";
import {
  SCHEMA_VERSION,
  type AgentRef,
  type RunConfig,
  type RunError,
  type Span,
  type SpanKind,
  type Trace,
  type TraceTotals,
  type Usage,
} from "../core/types.ts";
import type { GenerateRequest, ModelClient } from "../provider/types.ts";

export interface SpanHandle {
  id: string;
  end(result: { output: unknown; usage?: Usage | null; error?: RunError | null }): void;
}

export interface RecorderOptions {
  agent: AgentRef;
  config: RunConfig;
  /** Applied to every span input and output before it touches disk. */
  redact?: (value: unknown) => unknown;
  replayOf?: string | null;
  tags?: string[];
}

function toRunError(error: unknown): RunError {
  if (error instanceof Error) return { message: error.message, type: error.name };
  return { message: String(error) };
}

export class Recorder {
  #spans: Span[] = [];
  #stack: string[] = [];
  #startedAt = Date.now();
  #options: RecorderOptions;
  #redact: (value: unknown) => unknown;

  constructor(options: RecorderOptions) {
    this.#options = options;
    // Redaction happens on the way IN, so sensitive payloads never reach disk.
    this.#redact = options.redact ?? ((v) => v);
  }

  get spans(): readonly Span[] {
    return this.#spans;
  }

  startSpan(init: { kind: SpanKind; name: string; input: unknown }): SpanHandle {
    const id = newId("span");
    const span: Span = {
      id,
      parentId: this.#stack.at(-1) ?? null,
      kind: init.kind,
      name: init.name,
      startedAt: Date.now(),
      endedAt: 0,
      input: this.#redact(init.input),
      output: null,
      usage: null,
      error: null,
    };
    this.#spans.push(span);
    this.#stack.push(id);

    let ended = false;
    return {
      id,
      end: (result) => {
        if (ended) return;
        ended = true;
        span.endedAt = Date.now();
        span.output = this.#redact(result.output);
        span.usage = result.usage ?? null;
        span.error = result.error ?? null;
        const top = this.#stack.lastIndexOf(id);
        if (top !== -1) this.#stack.splice(top, 1);
      },
    };
  }

  /** Returns a client that records every generate() call as a model span. */
  wrapModel(client: ModelClient): ModelClient {
    return {
      providerId: client.providerId,
      generate: async (request: GenerateRequest) => {
        const span = this.startSpan({
          kind: "model",
          name: request.model,
          input: request,
        });
        try {
          const response = await client.generate(request);
          span.end({ output: response, usage: response.usage });
          return response;
        } catch (error) {
          span.end({ output: null, error: toRunError(error) });
          throw error;
        }
      },
    };
  }

  /** Returns a tool function that records every call as a tool span. */
  wrapTool<I, O>(name: string, fn: (input: I) => Promise<O> | O): (input: I) => Promise<O> {
    return async (input: I) => {
      const span = this.startSpan({ kind: "tool", name, input });
      try {
        const output = await fn(input);
        span.end({ output });
        return output;
      } catch (error) {
        span.end({ output: null, error: toRunError(error) });
        throw error;
      }
    };
  }

  finish(result: { input: unknown; output: unknown; error?: RunError | null }): Trace {
    const endedAt = Date.now();

    // Close anything the agent left open rather than writing a torn trace.
    for (const span of this.#spans) {
      if (span.endedAt === 0) {
        span.endedAt = endedAt;
        span.error ??= { message: "span never ended", type: "TornSpan" };
      }
    }

    const totals: TraceTotals = this.#spans.reduce<TraceTotals>(
      (acc, span) => ({
        inputTokens: acc.inputTokens + (span.usage?.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (span.usage?.outputTokens ?? 0),
        costUsd: acc.costUsd + (span.usage?.costUsd ?? 0),
        wallMs: endedAt - this.#startedAt,
        steps: acc.steps + 1,
      }),
      { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: endedAt - this.#startedAt, steps: 0 },
    );

    return {
      id: newId("trace"),
      schemaVersion: SCHEMA_VERSION,
      agent: this.#options.agent,
      config: this.#options.config,
      input: this.#redact(result.input),
      output: this.#redact(result.output),
      spans: this.#spans,
      startedAt: this.#startedAt,
      endedAt,
      totals,
      error: result.error ?? null,
      replayOf: this.#options.replayOf ?? null,
      tags: this.#options.tags ?? [],
    };
  }
}
