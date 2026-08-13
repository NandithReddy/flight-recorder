/**
 * Replay — phase 0 form.
 *
 * Today this re-runs a registered agent against a stored trace's input under a
 * (possibly different) RunConfig and records the result. Phase 3 turns this
 * into the matrix runner: concurrency, rate-limit backoff, resumability, a
 * sandbox for live mode, and the stubbed mode that plays recorded tool
 * responses back so the environment is held still.
 */

import { Recorder } from "../recorder/recorder.ts";
import { keepEverything, type Sampler, type SamplingDecision } from "../recorder/sampling.ts";
import type { Redactor } from "../recorder/redact.ts";
import type { AgentRef, RunConfig, Trace } from "../core/types.ts";
import type { ModelClient } from "../provider/types.ts";
import type { TraceStore } from "../store/types.ts";

export interface AgentContext {
  recorder: Recorder;
  client: ModelClient;
  /**
   * The model to call, taken from the RunConfig.
   *
   * An agent must not hardcode this: the model is half of what a config varies,
   * so an agent that names its own model silently ignores the matrix and every
   * row of the report compares the same thing against itself.
   */
  model: string;
}

/** What an agent must expose to be recordable and replayable. */
export interface RecordableAgent<Input = unknown, Output = unknown> {
  ref: AgentRef;
  run(input: Input, ctx: AgentContext): Promise<Output>;
}

export interface RunOptions {
  agent: RecordableAgent;
  client: ModelClient;
  config: RunConfig;
  input: unknown;
  store?: TraceStore;
  replayOf?: string | null;
  tags?: string[];
  /** Applied on the way in; defaults to the standard credential ruleset. */
  redact?: Redactor;
  /** Decides whether the trace reaches the store. Defaults to keeping all. */
  sampler?: Sampler;
}

export interface RecordResult {
  trace: Trace;
  sampling: SamplingDecision;
}

/**
 * Record one run of an agent.
 *
 * The trace is always returned in full — sampling only decides whether it is
 * persisted, never whether it is captured. A caller that wants the trace for
 * this request gets it regardless of the policy.
 *
 * The sampling decision rides alongside the trace rather than on it. Attaching
 * it to the trace would mutate a value that D-004 requires to be immutable and
 * content-addressed: the same trace would then hash differently depending on
 * whether you hashed it before or after this function returned.
 */
export async function record(options: RunOptions): Promise<RecordResult> {
  const recorder = new Recorder({
    agent: options.agent.ref,
    config: options.config,
    replayOf: options.replayOf ?? null,
    tags: options.tags ?? [],
    ...(options.redact ? { redact: options.redact } : {}),
  });

  const client = recorder.wrapModel(options.client);

  let output: unknown = null;
  let error: { message: string; type?: string } | null = null;
  try {
    output = await options.agent.run(options.input, {
      recorder,
      client,
      model: options.config.model,
    });
  } catch (caught) {
    error =
      caught instanceof Error
        ? { message: caught.message, type: caught.name }
        : { message: String(caught) };
  }

  const trace = recorder.finish({ input: options.input, output, error });

  const sampling = (options.sampler ?? keepEverything)(trace);
  if (sampling.keep) await options.store?.put(trace);

  return { trace, sampling };
}

export interface ReplayResult {
  baseline: Trace;
  candidate: Trace;
}

/** Re-run a stored trace's input under a new config. */
export async function replay(options: {
  traceId: string;
  agent: RecordableAgent;
  client: ModelClient;
  config: RunConfig;
  store: TraceStore;
}): Promise<ReplayResult> {
  const baseline = await options.store.get(options.traceId);
  if (!baseline) throw new Error(`No trace with id ${options.traceId}`);

  const { trace: candidate } = await record({
    agent: options.agent,
    client: options.client,
    config: options.config,
    input: baseline.input,
    store: options.store,
    replayOf: baseline.id,
    tags: ["replay"],
  });

  return { baseline, candidate };
}
