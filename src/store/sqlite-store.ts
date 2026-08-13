/**
 * SQLite trace store with payload-level deduplication.
 *
 * Two things changed from the phase-0 filesystem store, both for the same
 * reason — an index that can disagree with its blobs is a bug generator:
 *
 *   1. Everything lives in one transactional database file. The phase-0 store
 *      needed defensive code for "index references a blob that isn't there";
 *      here that state cannot exist, and the whole store is one file to copy.
 *
 *   2. Large repeated subtrees are extracted and stored once, content-addressed.
 *      Agent traces repeat the same system prompt and the same tool schemas on
 *      every single span; storing them per-span is most of the disk cost.
 *
 * `node:sqlite` is built into Node, so this adds no dependency and no native
 * compile step.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sha256, stableStringify } from "../core/ids.ts";
import type { Attempt, ReplayMode, RunError, Trace, TraceSummary } from "../core/types.ts";
import type { TraceStore } from "./types.ts";
import { DEFAULT_ROOT } from "./fs-store.ts";

interface AttemptRow {
  id: string;
  case_id: string;
  config_id: string;
  mode: string;
  trace_id: string;
  started_at: number;
  ended_at: number;
  error: string | null;
}

function rowToAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    caseId: row.case_id,
    configId: row.config_id,
    mode: row.mode as ReplayMode,
    traceId: row.trace_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    error: row.error === null ? null : (JSON.parse(row.error) as RunError),
  };
}

/** Marker for an extracted subtree. `$fr` keeps it distinguishable from data. */
interface PayloadRef {
  $fr: "payload";
  sha: string;
}

function isPayloadRef(value: unknown): value is PayloadRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as PayloadRef).$fr === "payload" &&
    typeof (value as PayloadRef).sha === "string"
  );
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payloads (
  sha   TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  body  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
  id            TEXT PRIMARY KEY,
  sha           TEXT NOT NULL,
  body          TEXT NOT NULL,
  agent_name    TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  config_id     TEXT NOT NULL,
  model         TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  wall_ms       INTEGER NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd      REAL NOT NULL,
  steps         INTEGER NOT NULL,
  ok            INTEGER NOT NULL,
  replay_of     TEXT,
  tags          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS traces_started_at ON traces (started_at DESC);
CREATE INDEX IF NOT EXISTS traces_agent      ON traces (agent_name);
CREATE INDEX IF NOT EXISTS traces_config     ON traces (config_id);
CREATE INDEX IF NOT EXISTS traces_replay_of  ON traces (replay_of);

CREATE TABLE IF NOT EXISTS attempts (
  id         TEXT PRIMARY KEY,
  case_id    TEXT NOT NULL,
  config_id  TEXT NOT NULL,
  mode       TEXT NOT NULL,
  trace_id   TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER NOT NULL,
  error      TEXT,
  -- The identity of a matrix cell. Makes resumption a lookup rather than a
  -- bookkeeping problem, and makes re-running one idempotent.
  UNIQUE (case_id, config_id, mode)
);

CREATE INDEX IF NOT EXISTS attempts_case ON attempts (case_id);
`;

export interface SqliteStoreOptions {
  /**
   * Subtrees serialising to at least this many bytes are stored separately.
   * 256 is low enough to catch a system prompt and high enough that small
   * scalars stay inline where they are cheaper than a reference.
   */
  payloadThresholdBytes?: number;
}

interface TraceRow {
  id: string;
  sha: string;
  body: string;
  agent_name: string;
  agent_version: string;
  config_id: string;
  model: string;
  started_at: number;
  wall_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  steps: number;
  ok: number;
  replay_of: string | null;
  tags: string;
}

export class SqliteTraceStore implements TraceStore {
  #db: DatabaseSync;
  #threshold: number;
  #path: string;

  constructor(root: string = DEFAULT_ROOT, options: SqliteStoreOptions = {}) {
    this.#path = root.endsWith(".db") ? root : join(root, "traces.db");
    this.#threshold = options.payloadThresholdBytes ?? 256;

    if (this.#path !== ":memory:") mkdirSync(dirname(this.#path), { recursive: true });
    this.#db = new DatabaseSync(this.#path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(SCHEMA);
  }

  get path(): string {
    return this.#path;
  }

  close(): void {
    this.#db.close();
  }

  // -------------------------------------------------------------------------
  // Payload extraction
  // -------------------------------------------------------------------------

  /**
   * Replaces large subtrees with references, bottom-up.
   *
   * Bottom-up matters. Top-down would extract a span's whole input as one
   * payload — which is unique per span, so it would dedupe nothing. Going
   * upwards, the repeated system prompt is extracted first, and the message
   * array that contained it is then small enough to stay inline. The part that
   * actually repeats is the part that gets shared.
   */
  #externalize(value: unknown, out: Map<string, string>): unknown {
    if (value === null || typeof value !== "object") {
      if (typeof value === "string" && value.length >= this.#threshold) {
        return this.#storePayload(value, out);
      }
      return value;
    }

    const mapped: unknown = Array.isArray(value)
      ? value.map((item) => this.#externalize(item, out))
      : Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [
            k,
            this.#externalize(v, out),
          ]),
        );

    const serialized = stableStringify(mapped);
    if (serialized.length >= this.#threshold) return this.#storePayload(mapped, out);
    return mapped;
  }

  #storePayload(value: unknown, out: Map<string, string>): PayloadRef {
    const body = stableStringify(value);
    const sha = sha256(body);
    out.set(sha, body);
    return { $fr: "payload", sha };
  }

  #internalize(value: unknown, cache: Map<string, unknown>): unknown {
    if (isPayloadRef(value)) {
      const cached = cache.get(value.sha);
      if (cached !== undefined) return cached;

      const row = this.#db.prepare("SELECT body FROM payloads WHERE sha = ?").get(value.sha) as
        | { body: string }
        | undefined;
      if (!row) throw new Error(`Trace references payload ${value.sha}, which is missing`);

      const parsed = this.#internalize(JSON.parse(row.body), cache);
      cache.set(value.sha, parsed);
      return parsed;
    }

    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => this.#internalize(item, cache));

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        this.#internalize(v, cache),
      ]),
    );
  }

  // -------------------------------------------------------------------------
  // TraceStore
  // -------------------------------------------------------------------------

  async put(trace: Trace): Promise<{ id: string; sha: string; deduped: boolean }> {
    const canonical = stableStringify(trace);
    const sha = sha256(canonical);

    const existing = this.#db.prepare("SELECT id FROM traces WHERE id = ?").get(trace.id) as
      | { id: string }
      | undefined;

    const payloads = new Map<string, string>();
    const skeleton = {
      ...trace,
      input: this.#externalize(trace.input, payloads),
      output: this.#externalize(trace.output, payloads),
      spans: trace.spans.map((span) => ({
        ...span,
        input: this.#externalize(span.input, payloads),
        output: this.#externalize(span.output, payloads),
      })),
    };

    this.#db.exec("BEGIN");
    try {
      const insertPayload = this.#db.prepare(
        "INSERT OR IGNORE INTO payloads (sha, bytes, body) VALUES (?, ?, ?)",
      );
      for (const [payloadSha, body] of payloads) {
        insertPayload.run(payloadSha, body.length, body);
      }

      this.#db
        .prepare(
          `INSERT OR REPLACE INTO traces
             (id, sha, body, agent_name, agent_version, config_id, model, started_at,
              wall_ms, input_tokens, output_tokens, cost_usd, steps, ok, replay_of, tags)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          trace.id,
          sha,
          JSON.stringify(skeleton),
          trace.agent.name,
          trace.agent.version,
          trace.config.id,
          trace.config.model,
          trace.startedAt,
          trace.totals.wallMs,
          trace.totals.inputTokens,
          trace.totals.outputTokens,
          trace.totals.costUsd,
          trace.totals.steps,
          trace.error === null ? 1 : 0,
          trace.replayOf,
          JSON.stringify(trace.tags),
        );

      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }

    return { id: trace.id, sha, deduped: existing !== undefined };
  }

  async get(id: string): Promise<Trace | null> {
    const row = this.#db.prepare("SELECT body FROM traces WHERE id = ?").get(id) as
      | { body: string }
      | undefined;
    if (!row) return null;
    return this.#internalize(JSON.parse(row.body), new Map()) as Trace;
  }

  async list(options: { limit?: number; agent?: string } = {}): Promise<TraceSummary[]> {
    const clauses = options.agent ? "WHERE agent_name = ?" : "";
    const limit = options.limit ?? -1;
    const params: (string | number)[] = [];
    if (options.agent) params.push(options.agent);
    params.push(limit);

    const rows = this.#db
      .prepare(`SELECT * FROM traces ${clauses} ORDER BY started_at DESC LIMIT ?`)
      .all(...params) as unknown as TraceRow[];

    return rows.map((row) => ({
      id: row.id,
      sha: row.sha,
      agent: { name: row.agent_name, version: row.agent_version },
      configId: row.config_id,
      model: row.model,
      startedAt: row.started_at,
      totals: {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        costUsd: row.cost_usd,
        wallMs: row.wall_ms,
        steps: row.steps,
      },
      ok: row.ok === 1,
      replayOf: row.replay_of,
      tags: JSON.parse(row.tags) as string[],
    }));
  }

  async stats(): Promise<{ traces: number; blobs: number; bytes: number }> {
    const traces = this.#db.prepare("SELECT COUNT(*) AS n FROM traces").get() as { n: number };
    const payloads = this.#db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM payloads")
      .get() as { n: number; b: number };
    const skeletons = this.#db
      .prepare("SELECT COALESCE(SUM(LENGTH(body)), 0) AS b FROM traces")
      .get() as { b: number };

    return {
      traces: traces.n,
      blobs: payloads.n,
      bytes: payloads.b + skeletons.b,
    };
  }

  // -------------------------------------------------------------------------
  // Attempts — one matrix cell each
  // -------------------------------------------------------------------------

  putAttempt(attempt: Attempt): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO attempts
           (id, case_id, config_id, mode, trace_id, started_at, ended_at, error)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        attempt.id,
        attempt.caseId,
        attempt.configId,
        attempt.mode,
        attempt.traceId,
        attempt.startedAt,
        attempt.endedAt,
        attempt.error === null ? null : JSON.stringify(attempt.error),
      );
  }

  findAttempt(caseId: string, configId: string, mode: ReplayMode): Attempt | null {
    const row = this.#db
      .prepare("SELECT * FROM attempts WHERE case_id = ? AND config_id = ? AND mode = ?")
      .get(caseId, configId, mode) as AttemptRow | undefined;
    return row ? rowToAttempt(row) : null;
  }

  listAttempts(caseId?: string): Attempt[] {
    const rows = caseId
      ? (this.#db
          .prepare("SELECT * FROM attempts WHERE case_id = ? ORDER BY started_at")
          .all(caseId) as unknown as AttemptRow[])
      : (this.#db
          .prepare("SELECT * FROM attempts ORDER BY started_at")
          .all() as unknown as AttemptRow[]);
    return rows.map(rowToAttempt);
  }

  /** What deduplication actually saved, for the phase-2 exit evidence. */
  async dedupeStats(): Promise<{
    uniquePayloads: number;
    references: number;
    storedBytes: number;
    naiveBytes: number;
  }> {
    const rows = this.#db.prepare("SELECT body FROM traces").all() as unknown as {
      body: string;
    }[];

    const sizes = new Map<string, number>();
    for (const row of this.#db
      .prepare("SELECT sha, bytes FROM payloads")
      .all() as unknown as { sha: string; bytes: number }[]) {
      sizes.set(row.sha, row.bytes);
    }

    let references = 0;
    let naive = 0;
    for (const row of rows) {
      naive += row.body.length;
      for (const match of row.body.matchAll(/"\$fr":"payload","sha":"([a-f0-9]{64})"/g)) {
        const sha = match[1];
        if (sha === undefined) continue;
        references += 1;
        naive += sizes.get(sha) ?? 0;
      }
    }

    const stored = await this.stats();
    return {
      uniquePayloads: sizes.size,
      references,
      storedBytes: stored.bytes,
      naiveBytes: naive,
    };
  }
}
