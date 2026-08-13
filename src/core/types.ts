/**
 * The seven objects the whole system is built from.
 *
 * Phase 0 implements Trace, Span and RunConfig end to end. TestCase, Attempt,
 * Verdict and Report are defined here now — deliberately — because every later
 * phase falls out of these shapes, and discovering a modelling mistake in
 * phase 5 means rewriting the store twice. Their implementations land in
 * phases 2, 3, 4 and 5 respectively.
 */

export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Span — one step inside a run
// ---------------------------------------------------------------------------

export type SpanKind = "model" | "tool";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RunError {
  message: string;
  type?: string;
}

export interface Span {
  id: string;
  parentId: string | null;
  kind: SpanKind;
  /** Model id for `model` spans, tool name for `tool` spans. */
  name: string;
  startedAt: number;
  endedAt: number;
  input: unknown;
  output: unknown;
  usage: Usage | null;
  error: RunError | null;
}

// ---------------------------------------------------------------------------
// RunConfig — everything that could change the answer
// ---------------------------------------------------------------------------

/**
 * The unit of comparison. A report is always "config A vs config B", so any
 * field that can move the output belongs here and nowhere else. `id` is a
 * stable hash of the other fields, which is what makes a baseline pinnable.
 */
export interface RunConfig {
  id: string;
  provider: string;
  model: string;
  promptVersion: string;
  toolset: string[];
  temperature?: number;
  seed?: number;
  /** Free-form provider knobs that still affect the answer. */
  extra?: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Trace — one immutable recording of one run
// ---------------------------------------------------------------------------

export interface TraceTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallMs: number;
  steps: number;
}

export interface AgentRef {
  name: string;
  version: string;
}

export interface Trace {
  id: string;
  schemaVersion: typeof SCHEMA_VERSION;
  agent: AgentRef;
  config: RunConfig;
  input: unknown;
  output: unknown;
  spans: Span[];
  startedAt: number;
  endedAt: number;
  totals: TraceTotals;
  error: RunError | null;
  /** Set when this trace was produced by replaying a TestCase. */
  replayOf: string | null;
  tags: string[];
}

export interface TraceSummary {
  id: string;
  sha: string;
  agent: AgentRef;
  configId: string;
  model: string;
  startedAt: number;
  totals: TraceTotals;
  ok: boolean;
  replayOf: string | null;
  tags: string[];
}

// ---------------------------------------------------------------------------
// TestCase — a trace promoted into a fixture  [phase 2]
// ---------------------------------------------------------------------------

export type AssertionKind =
  | "output_contains"
  | "output_matches"
  | "output_json_valid"
  | "tool_called"
  | "tool_not_called"
  | "max_steps"
  | "max_cost_usd"
  | "max_wall_ms"
  | "no_error";

export interface Assertion {
  id: string;
  kind: AssertionKind;
  /** Interpretation depends on `kind`; a string, number or pattern. */
  value: string | number;
  /** Hard assertions fail the case outright and skip the judge (tier 1). */
  hard: boolean;
  /** Why this assertion exists — carried into the report on failure. */
  note?: string;
}

export interface TestCase {
  id: string;
  sourceTraceId: string;
  input: unknown;
  assertions: Assertion[];
  /** Optional tier-2 rubric. Absent means deterministic checks only. */
  rubric: string | null;
  /** Trace id whose output the judge compares against. */
  baselineTraceId: string;
  tags: string[];
  createdAt: number;
}

export interface Suite {
  id: string;
  name: string;
  caseIds: string[];
  /** Baseline pinned by commit so a comparison is reproducible later. */
  baselineCommit: string | null;
}

// ---------------------------------------------------------------------------
// Attempt — one case executed under one config  [phase 3]
// ---------------------------------------------------------------------------

export interface Attempt {
  id: string;
  caseId: string;
  configId: string;
  /** The recording this attempt produced — attempts are fully inspectable. */
  traceId: string;
  mode: ReplayMode;
  startedAt: number;
  endedAt: number;
  error: RunError | null;
}

/**
 * `live` executes tools for real inside a sandbox. `stubbed` plays tool
 * responses back from the recorded trace, holding the environment still so the
 * only thing that varies is the model and prompt. Running both is what
 * separates a model regression from environment drift.
 */
export type ReplayMode = "live" | "stubbed";

// ---------------------------------------------------------------------------
// Verdict — pass/fail for one attempt, with provenance  [phase 4]
// ---------------------------------------------------------------------------

export type ScorerTier = "deterministic" | "judge";

export interface Verdict {
  attemptId: string;
  pass: boolean;
  /** 0..1. Deterministic verdicts are 0 or 1; judged verdicts may be fractional. */
  score: number;
  reason: string;
  /** Which tier decided this. The report separates hard failures from judged ones. */
  decidedBy: ScorerTier;
  /**
   * How much this verdict should be trusted. For judged verdicts this carries
   * the judge's current Cohen's kappa against human labels; below ~0.6 the
   * report marks the verdict untrusted rather than presenting it as fact.
   */
  trust: number | null;
  failedAssertionIds: string[];
}

// ---------------------------------------------------------------------------
// Report — an aggregate against a baseline  [phase 5]
// ---------------------------------------------------------------------------

export interface Interval {
  point: number;
  lower: number;
  upper: number;
  significant: boolean;
}

export interface CaseDelta {
  caseId: string;
  before: boolean;
  after: boolean;
  /** true when before=pass and after=fail. */
  regressed: boolean;
  reason: string;
}

export interface Report {
  id: string;
  createdAt: number;
  baselineConfigId: string;
  candidateConfigId: string;
  n: number;
  passRateBefore: number;
  passRateAfter: number;
  passRateDelta: Interval;
  costPerTaskBefore: number;
  costPerTaskAfter: number;
  latencyP95Before: number;
  latencyP95After: number;
  /** Judge agreement with human labels at the time of the run. */
  judgeKappa: number | null;
  cases: CaseDelta[];
}
