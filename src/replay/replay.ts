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
import type { AgentRef, RunConfig, Trace } from "../core/types.ts";
import type { ModelClient } from "../provider/types.ts";
import type { TraceStore } from "../store/types.ts";

export interface AgentContext {
  recorder: Recorder;
  client: ModelClient;
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
}

/** Record one run of an agent, storing the trace if a store is supplied. */
export async function record(options: RunOptions): Promise<Trace> {
  const recorder = new Recorder({
    agent: options.agent.ref,
    config: options.config,
    replayOf: options.replayOf ?? null,
    tags: options.tags ?? [],
  });

  const client = recorder.wrapModel(options.client);

  let output: unknown = null;
  let error: { message: string; type?: string } | null = null;
  try {
    output = await options.agent.run(options.input, { recorder, client });
  } catch (caught) {
    error =
      caught instanceof Error
        ? { message: caught.message, type: caught.name }
        : { message: String(caught) };
  }

  const trace = recorder.finish({ input: options.input, output, error });
  await options.store?.put(trace);
  return trace;
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

  const candidate = await record({
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
