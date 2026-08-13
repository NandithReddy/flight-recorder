/**
 * The recorder.
 *
 * Wraps the model client and the tools at the client boundary, appends spans,
 * and never blocks or scores anything.
 *
 * It writes to two places at once, and the reason is load-bearing. OpenTelemetry
 * spans go out to whatever collector the host application has registered — that
 * is the ecosystem artefact, and it costs nothing when no SDK is registered
 * because the API package degrades to a no-op. The Trace object is assembled
 * independently, in memory, and it is the replayable fixture.
 *
 * They cannot be the same thing. A telemetry pipeline is allowed to sample,
 * batch, drop under backpressure, and truncate long attributes — all correct
 * behaviour for observability, and all fatal for a test fixture, which must be
 * complete or it is not a fixture. So the Trace never travels through the
 * exporter path. See DECISIONS D-010.
 */

import {
  context as otelContext,
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  trace as otelTrace,
  type Attributes,
  type Span as OtelSpan,
  type Tracer,
} from "@opentelemetry/api";

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
import {
  FR,
  GenAI,
  OPERATION_CHAT,
  OPERATION_EXECUTE_TOOL,
  TRACER_NAME,
  TRACER_VERSION,
} from "../otel/conventions.ts";
import { defaultRedactor, type Redactor } from "./redact.ts";

export interface SpanInit {
  kind: SpanKind;
  name: string;
  input: unknown;
  /** Extra OTel attributes for this span. Never enters the Trace object. */
  attributes?: Attributes;
}

export interface SpanResult {
  output: unknown;
  usage?: Usage | null;
  error?: RunError | null;
  attributes?: Attributes;
}

/**
 * Anything that can open spans. A Recorder is the root scope; every SpanHandle
 * exposes a child scope, so nesting is explicit rather than inferred from a
 * mutable stack — which is what makes concurrent tool calls come out with the
 * right parents instead of whichever span happened to be on top.
 */
export interface SpanScope {
  startSpan(init: SpanInit): SpanHandle;
  wrapModel(client: ModelClient): ModelClient;
  wrapTool<I, O>(name: string, fn: (input: I) => Promise<O> | O): (input: I) => Promise<O>;
}

export interface SpanHandle {
  id: string;
  /** Opens spans parented to this one. */
  scope: SpanScope;
  end(result: SpanResult): void;
}

export interface ToolCallContext {
  name: string;
  input: unknown;
  /** Runs the real tool. A stub simply never calls it. */
  execute: () => Promise<unknown>;
}

/**
 * Sits between a tool call and the tool.
 *
 * This is the seam that makes stubbed replay possible: the interceptor can
 * answer from a recording instead of executing, so the environment is held
 * perfectly still and the only thing that varies is the model. It is also where
 * a sandbox plugs in for tools that touch the outside world.
 */
export type ToolInterceptor = (context: ToolCallContext) => Promise<unknown>;

export interface RecorderOptions {
  agent: AgentRef;
  config: RunConfig;
  /** Applied to every span input and output before it is held. */
  redact?: Redactor;
  replayOf?: string | null;
  tags?: string[];
  /** Overrides the global tracer; tests use this to capture emitted spans. */
  tracer?: Tracer;
  /** Answers tool calls instead of executing them. */
  toolInterceptor?: ToolInterceptor;
}

function toRunError(error: unknown): RunError {
  if (error instanceof Error) return { message: error.message, type: error.name };
  return { message: String(error) };
}

/**
 * Marks a wrapped client so it can be unwrapped again.
 *
 * Without this, wrapping an already-wrapped client nests the instrumentation
 * and every model call records two spans — doubling the token and cost totals
 * with no error and no visible symptom. It is an easy mistake to make, because
 * the client handed to an agent is already wrapped, so an agent that wants a
 * differently-scoped client naturally reaches for `wrapModel` again. Re-wrapping
 * therefore re-scopes the original rather than layering on top of the wrapper.
 */
const UNWRAPPED: unique symbol = Symbol.for("flightrecorder.unwrapped");

interface MaybeWrapped extends ModelClient {
  [UNWRAPPED]?: ModelClient;
}

/** Returns the innermost real client, however many times it has been wrapped. */
export function unwrapClient(client: ModelClient): ModelClient {
  return (client as MaybeWrapped)[UNWRAPPED] ?? client;
}

export class Recorder implements SpanScope {
  #spans: Span[] = [];
  #otelSpans = new Map<string, OtelSpan>();
  #startedAt = Date.now();
  #options: RecorderOptions;
  #redact: Redactor;
  #tracer: Tracer;

  constructor(options: RecorderOptions) {
    this.#options = options;
    // Redaction happens on the way IN, so secrets never reach the trace.
    this.#redact = options.redact ?? defaultRedactor;
    this.#tracer = options.tracer ?? otelTrace.getTracer(TRACER_NAME, TRACER_VERSION);
  }

  get spans(): readonly Span[] {
    return this.#spans;
  }

  startSpan(init: SpanInit): SpanHandle {
    return this.#open(init, null);
  }

  wrapModel(client: ModelClient): ModelClient {
    return this.#wrapModel(client, null);
  }

  wrapTool<I, O>(name: string, fn: (input: I) => Promise<O> | O): (input: I) => Promise<O> {
    return this.#wrapTool(name, fn, null);
  }

  // -------------------------------------------------------------------------
  // Internals — every operation takes an explicit parent, so scoping is data
  // rather than ambient state.
  // -------------------------------------------------------------------------

  #scopeFor(parentId: string | null): SpanScope {
    return {
      startSpan: (init) => this.#open(init, parentId),
      wrapModel: (client) => this.#wrapModel(client, parentId),
      wrapTool: (name, fn) => this.#wrapTool(name, fn, parentId),
    };
  }

  #otelName(init: SpanInit): string {
    return init.kind === "model"
      ? `${OPERATION_CHAT} ${init.name}`
      : `${OPERATION_EXECUTE_TOOL} ${init.name}`;
  }

  #baseAttributes(init: SpanInit, id: string): Attributes {
    const config = this.#options.config;
    const attributes: Attributes = {
      [GenAI.SYSTEM]: config.provider,
      [FR.SPAN_ID]: id,
      [FR.CONFIG_ID]: config.id,
      [FR.AGENT_NAME]: this.#options.agent.name,
      [FR.AGENT_VERSION]: this.#options.agent.version,
    };

    if (init.kind === "model") {
      attributes[GenAI.OPERATION_NAME] = OPERATION_CHAT;
      attributes[GenAI.REQUEST_MODEL] = init.name;
      if (config.temperature !== undefined) {
        attributes[GenAI.REQUEST_TEMPERATURE] = config.temperature;
      }
    } else {
      attributes[GenAI.OPERATION_NAME] = OPERATION_EXECUTE_TOOL;
      attributes[GenAI.TOOL_NAME] = init.name;
    }

    return { ...attributes, ...init.attributes };
  }

  #open(init: SpanInit, parentId: string | null): SpanHandle {
    const id = newId("span");

    const parentOtel = parentId === null ? undefined : this.#otelSpans.get(parentId);
    const ctx =
      parentOtel === undefined
        ? otelContext.active()
        : otelTrace.setSpan(otelContext.active(), parentOtel);

    const otelSpan = this.#tracer.startSpan(
      this.#otelName(init),
      { kind: OtelSpanKind.CLIENT, attributes: this.#baseAttributes(init, id) },
      ctx,
    );
    this.#otelSpans.set(id, otelSpan);

    const span: Span = {
      id,
      parentId,
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

    let ended = false;
    return {
      id,
      scope: this.#scopeFor(id),
      end: (result) => {
        if (ended) return;
        ended = true;

        span.endedAt = Date.now();
        span.output = this.#redact(result.output);
        span.usage = result.usage ?? null;
        span.error = result.error ?? null;

        if (result.attributes) otelSpan.setAttributes(result.attributes);
        if (span.usage) {
          otelSpan.setAttributes({
            [GenAI.USAGE_INPUT_TOKENS]: span.usage.inputTokens,
            [GenAI.USAGE_OUTPUT_TOKENS]: span.usage.outputTokens,
            [FR.COST_USD]: span.usage.costUsd,
          });
        }
        if (span.error) {
          otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: span.error.message });
        }
        otelSpan.end();
      },
    };
  }

  #wrapModel(client: ModelClient, parentId: string | null): ModelClient {
    // Re-scope the original rather than wrapping a wrapper — see UNWRAPPED.
    const target = unwrapClient(client);

    const wrapped: MaybeWrapped = {
      providerId: target.providerId,
      generate: async (request: GenerateRequest) => {
        const span = this.#open(
          {
            kind: "model",
            name: request.model,
            input: request,
            attributes:
              request.maxTokens === undefined
                ? undefined
                : { [GenAI.REQUEST_MAX_TOKENS]: request.maxTokens },
          },
          parentId,
        );
        try {
          const response = await target.generate(request);
          span.end({
            output: response,
            usage: response.usage,
            attributes: {
              [GenAI.RESPONSE_MODEL]: request.model,
              [GenAI.RESPONSE_FINISH_REASONS]: [response.finishReason],
            },
          });
          return response;
        } catch (error) {
          span.end({ output: null, error: toRunError(error) });
          throw error;
        }
      },
    };

    wrapped[UNWRAPPED] = target;
    return wrapped;
  }

  #wrapTool<I, O>(
    name: string,
    fn: (input: I) => Promise<O> | O,
    parentId: string | null,
  ): (input: I) => Promise<O> {
    const interceptor = this.#options.toolInterceptor;

    return async (input: I) => {
      const span = this.#open({ kind: "tool", name, input }, parentId);
      try {
        const output = interceptor
          ? ((await interceptor({
              name,
              input,
              execute: async () => fn(input),
            })) as O)
          : await fn(input);
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
        const otelSpan = this.#otelSpans.get(span.id);
        if (otelSpan) {
          otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: "span never ended" });
          otelSpan.end();
        }
      }
    }

    const wallMs = endedAt - this.#startedAt;
    const totals = this.#spans.reduce<TraceTotals>(
      (acc, span) => ({
        inputTokens: acc.inputTokens + (span.usage?.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (span.usage?.outputTokens ?? 0),
        costUsd: acc.costUsd + (span.usage?.costUsd ?? 0),
        wallMs,
        steps: acc.steps + 1,
      }),
      { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs, steps: 0 },
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
