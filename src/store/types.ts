import type { Trace, TraceSummary } from "../core/types.ts";

/**
 * One interface, so the phase 2 swap from files to SQLite and the eventual
 * swap to Postgres + object storage never reach callers.
 */
export interface TraceStore {
  /** Content-addressed. Writing the same trace twice stores one blob. */
  put(trace: Trace): Promise<{ id: string; sha: string; deduped: boolean }>;
  get(id: string): Promise<Trace | null>;
  list(options?: { limit?: number; agent?: string }): Promise<TraceSummary[]>;
  stats(): Promise<{ traces: number; blobs: number; bytes: number }>;
}
