/**
 * The matrix runner.
 *
 * A cell is one (case × config × mode). The exit criterion for this phase is
 * that fifty cases across three configs run unattended to completion, which in
 * practice means three properties rather than one:
 *
 *   - **Bounded concurrency.** Local models saturate a machine at two or three
 *     in flight; hosted ones rate-limit. Neither wants a fan-out of 150.
 *   - **Retries that distinguish transient from real.** Retrying a rate limit
 *     is correct; retrying a bad expression just spends money three times to
 *     record the same failure.
 *   - **Resumability.** A 150-cell run that dies at cell 140 must not start
 *     over. Every finished cell is persisted as an Attempt keyed by its
 *     identity, so resuming is a lookup.
 */

import { newId } from "../core/ids.ts";
import type { Attempt, ReplayMode, RunConfig, TestCase, Trace } from "../core/types.ts";
import { isEnvironmentFailure, type ModelClient } from "../provider/types.ts";
import type { SqliteTraceStore } from "../store/sqlite-store.ts";
import { getAgent } from "./registry.ts";
import { record, type RecordableAgent } from "./replay.ts";
import { createReplayStub, type StubReport } from "./stub.ts";

export interface MatrixCell {
  testCase: TestCase;
  config: RunConfig;
  mode: ReplayMode;
}

export interface CellResult {
  cell: MatrixCell;
  attempt: Attempt;
  trace: Trace | null;
  stub: StubReport | null;
  /** True when a stored attempt was reused instead of running. */
  resumed: boolean;
  retries: number;
}

export type MatrixEvent =
  | { type: "start"; total: number; skipped: number }
  | { type: "cell-start"; cell: MatrixCell; index: number; total: number }
  | { type: "cell-done"; result: CellResult; index: number; total: number }
  | { type: "cell-retry"; cell: MatrixCell; attempt: number; delayMs: number; reason: string };

export interface MatrixOptions {
  cases: TestCase[];
  configs: RunConfig[];
  /** Defaults to `["live"]`. Pass both to get the diagnostic comparison. */
  modes?: ReplayMode[];
  clientFor: (config: RunConfig) => ModelClient;
  /** Resolves the agent for a case; defaults to the registry lookup by name. */
  agentFor?: (testCase: TestCase) => RecordableAgent;
  store: SqliteTraceStore;
  /** In-flight cells. Default 3 — tuned for local models, raise for hosted. */
  concurrency?: number;
  /** Attempts per cell on transient failure. Default 3. */
  maxRetries?: number;
  /** Reuse stored attempts instead of re-running. Default true. */
  resume?: boolean;
  onEvent?: (event: MatrixEvent) => void;
  /** Injected so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface MatrixResult {
  results: CellResult[];
  ran: number;
  resumed: number;
  failed: number;
}

/**
 * Whether a failure is worth retrying.
 *
 * Deliberately conservative: an unrecognised error is treated as real. Retrying
 * a genuine failure three times triples the cost of learning the same thing, and
 * on a 150-cell matrix that is the difference between a run you leave alone and
 * one you have to babysit.
 */
export function isTransient(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return [
    "429",
    "rate limit",
    "too many requests",
    "overloaded",
    "503",
    "502",
    "504",
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "socket hang up",
    "fetch failed",
    "network",
  ].some((needle) => message.includes(needle));
}

/** Exponential backoff with full jitter, so retries do not synchronise. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30_000, 500 * 2 ** attempt);
  return Math.round(ceiling * random());
}

function buildCells(options: MatrixOptions): MatrixCell[] {
  const modes = options.modes ?? ["live"];
  const cells: MatrixCell[] = [];
  for (const testCase of options.cases) {
    for (const config of options.configs) {
      for (const mode of modes) cells.push({ testCase, config, mode });
    }
  }
  return cells;
}

async function runCell(
  cell: MatrixCell,
  options: MatrixOptions,
  emit: (event: MatrixEvent) => void,
): Promise<CellResult> {
  const agent = options.agentFor
    ? options.agentFor(cell.testCase)
    : getAgent(cell.testCase.agent.name);
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = options.maxRetries ?? 3;

  // Stubbed mode needs the recording whose tool responses we play back.
  let stubSource: Trace | null = null;
  if (cell.mode === "stubbed") {
    stubSource = await options.store.get(cell.testCase.baselineTraceId);
    if (!stubSource) {
      throw new Error(
        `Case ${cell.testCase.id} is stubbed against trace ` +
          `${cell.testCase.baselineTraceId}, which is not in the store.`,
      );
    }
  }

  const startedAt = Date.now();
  let retries = 0;

  for (;;) {
    const stub = stubSource ? createReplayStub(stubSource) : null;
    try {
      const { trace } = await record({
        agent,
        client: options.clientFor(cell.config),
        config: cell.config,
        input: cell.testCase.input,
        store: options.store,
        replayOf: cell.testCase.baselineTraceId,
        tags: ["matrix", cell.mode],
        ...(stub ? { toolInterceptor: stub.interceptor } : {}),
      });

      // An agent failure is a *result*, not an error: the trace records it and
      // the report should show it. A failure of the *environment* is neither —
      // a run that died because the model daemon was down is not evidence about
      // the agent, and storing it as an Attempt makes resume serve that
      // non-result forever (D-046). Rethrow so the retry path sees it and, if
      // it persists, the cell is reported as one that could not run.
      if (isEnvironmentFailure(trace.error)) {
        throw Object.assign(new Error(trace.error!.message), { name: trace.error!.type });
      }

      const attempt: Attempt = {
        id: newId("attempt"),
        caseId: cell.testCase.id,
        configId: cell.config.id,
        mode: cell.mode,
        traceId: trace.id,
        startedAt,
        endedAt: Date.now(),
        error: trace.error,
      };
      options.store.putAttempt(attempt);

      return { cell, attempt, trace, stub: stub?.report() ?? null, resumed: false, retries };
    } catch (error) {
      if (retries >= maxRetries - 1 || !isTransient(error)) throw error;

      const delayMs = backoffMs(retries);
      emit({
        type: "cell-retry",
        cell,
        attempt: retries + 1,
        delayMs,
        reason: error instanceof Error ? error.message : String(error),
      });
      retries += 1;
      await sleep(delayMs);
    }
  }
}

export async function runMatrix(options: MatrixOptions): Promise<MatrixResult> {
  const emit = options.onEvent ?? (() => {});
  const resume = options.resume ?? true;
  const concurrency = Math.max(1, options.concurrency ?? 3);

  const cells = buildCells(options);
  const results: CellResult[] = new Array<CellResult>(cells.length);

  // Resolve resumable cells up front so the progress total is honest.
  const pending: number[] = [];
  const resumedCells: number[] = [];
  let skipped = 0;
  cells.forEach((cell, index) => {
    const existing = resume
      ? options.store.findAttempt(cell.testCase.id, cell.config.id, cell.mode)
      : null;
    if (existing) {
      results[index] = {
        cell,
        attempt: existing,
        trace: null,
        stub: null,
        resumed: true,
        retries: 0,
      };
      skipped += 1;
      resumedCells.push(index);
    } else {
      pending.push(index);
    }
  });

  // A resumed cell carries its recorded trace, not just its attempt row.
  // Leaving it null reads downstream as "this cell has no result", so anything
  // computed over the matrix silently drops it — the same shrinking denominator
  // the failure path below is careful to avoid. The CLI's tier-1 rate did
  // exactly that, and a rate over the handful of cells that happened to run
  // that day reached three documents as if it covered the suite (D-045).
  await Promise.all(
    resumedCells.map(async (index) => {
      const result = results[index]!;
      if (!result.attempt.traceId) return;
      result.trace = await options.store.get(result.attempt.traceId);
    }),
  );

  emit({ type: "start", total: cells.length, skipped });

  let cursor = 0;
  let failed = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const slot = cursor;
      cursor += 1;
      if (slot >= pending.length) return;

      const index = pending[slot]!;
      const cell = cells[index]!;
      emit({ type: "cell-start", cell, index, total: cells.length });

      try {
        const result = await runCell(cell, options, emit);
        results[index] = result;
        emit({ type: "cell-done", result, index, total: cells.length });
      } catch (error) {
        // A cell that will not run at all still occupies its slot in the
        // matrix. Dropping it would silently shrink the denominator and make
        // the pass rate look better than it is.
        failed += 1;
        const attempt: Attempt = {
          id: newId("attempt"),
          caseId: cell.testCase.id,
          configId: cell.config.id,
          mode: cell.mode,
          traceId: "",
          startedAt: Date.now(),
          endedAt: Date.now(),
          error:
            error instanceof Error
              ? { message: error.message, type: error.name }
              : { message: String(error) },
        };
        results[index] = { cell, attempt, trace: null, stub: null, resumed: false, retries: 0 };
        emit({ type: "cell-done", result: results[index]!, index, total: cells.length });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

  return {
    results,
    ran: pending.length,
    resumed: skipped,
    failed,
  };
}
