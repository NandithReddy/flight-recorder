# Decision log

Append-only. Each entry records what was decided, why, and what would reverse
it. This file plus `PHASES.md` is what lets any session — or any other person —
pick the project up cold.

---

### D-001 · TypeScript on Node's native type stripping, no build step

Node 25 executes `.ts` directly, so there is no bundler, no `dist/`, and no
watch process. `tsconfig.json` sets `erasableSyntaxOnly`, which makes the
compiler reject syntax Node cannot strip (enums, namespaces, parameter
properties) rather than letting it fail at runtime. `tsc` runs for typechecking
only.

**Reverses if:** we need to publish to npm for consumers on older Node, at
which point a `tsdown`/`tsc` emit step gets added — but not before.

---

### D-002 · The provider is deliberately undecided — **resolved in phase 01, see D-012**

Everything talks to `ModelClient` in `src/provider/types.ts`. Adding Anthropic,
OpenAI, or the Vercel AI Gateway later is one adapter file and touches nothing
else.

---

### D-003 · All seven core objects defined on day one

`TestCase`, `Attempt`, `Verdict` and `Report` are fully typed in
`src/core/types.ts` even though they land in phases 2–5. Discovering a
modelling mistake in phase 5 means rewriting the store twice; discovering it
now costs an edit.

---

### D-004 · Trace identity is content-addressed; config identity is a hash of what can change the answer

`configId` hashes provider, model, prompt version, toolset, temperature and
seed. Two runs sharing a `configId` are directly comparable; two that do not
are not, and the report will refuse to pretend otherwise. Traces hash their
whole body, so writing the same trace twice stores one blob.

`stableStringify` sorts keys and drops `undefined`, so structurally equal
values always produce the same digest. Both properties are tested.

---

### D-005 · Redaction happens on the way in

The `redact` hook runs before a span input or output is held in memory, so
sensitive payloads never reach disk at all. Redacting on read would leave them
in the blobs forever.

---

### D-006 · The recorder never throws

An agent failure is captured as `trace.error` and the trace is still written. A
harness that loses the recording of a failed run loses the runs you most want
to freeze into test cases.

Spans the agent leaves open are force-closed at `finish()` and marked
`TornSpan` rather than writing a torn trace.

---

### D-007 · A mock provider carries phases 0–3

`createMockClient` is deterministic and free, so the whole capture → store →
replay loop runs with no API key and no spend. It has a `degraded` variant that
does not fail in any way that throws: it skips the verification tool call and
answers confidently with an unchecked number.

**Observation worth keeping for the writeup:** the degraded run is 33% cheaper
and 33% faster than the correct one, because skipping verification skips a
model call and a tool call. Any optimiser tuned on cost or latency alone would
promote the wrong agent. This is a concrete argument for why the report must
carry quality, cost and latency together, and never cost alone.

---

### D-008 · The demo agent is scaffolding, not the deliverable

`examples/demo-agent.ts` exists so every phase has something deterministic to
record and replay. Phase 7 points the harness at a real open-source agent —
that is the credible dogfood story. The demo agent's arithmetic tool is a
hand-written recursive-descent parser rather than `eval`, because an agent
under test must never hand model output to an evaluator.

---

### D-009 · Filesystem store now, SQLite in phase 2

`FsTraceStore` writes content-addressed blobs plus a JSON index. The blob
layout is already the one SQLite will point at, so the phase 2 migration
touches the index only, behind the existing `TraceStore` interface.
Payload-level dedupe (repeated system prompts) is explicitly deferred.

---

### D-010 · OpenTelemetry spans and Trace objects are written independently

The recorder emits both: OTel spans through `@opentelemetry/api` (using the
GenAI semantic conventions), and a `Trace` assembled in memory. They carry the
same data, and that duplication is deliberate.

A telemetry pipeline is *allowed* to sample, batch, drop under backpressure, and
truncate long attributes. All of that is correct behaviour for observability and
all of it is fatal for a test fixture, which is either complete or is not a
fixture. So the Trace never travels through the exporter path.

The upside of the OTel half is that it costs nothing when unused — with no SDK
registered, the API package is a no-op — and it means a Flight Recorder trace
lands in any existing collector already understood.

**Reverses if:** we ever find ourselves reconstructing a Trace *from* exported
spans. That would mean the fixture now depends on a lossy pipeline, and the
whole point is gone.

---

### D-011 · Re-wrapping a client re-scopes it rather than nesting

`Recorder.wrapModel` on an already-wrapped client unwraps to the original and
wraps that. Found by a failing test in phase 01: `AgentContext.client` arrives
already wrapped, so an agent wanting a differently-scoped client naturally calls
`wrapModel` again — and every model call then recorded **two** spans, silently
doubling token counts and cost with no error and no visible symptom.

Worth remembering for the writeup: this is precisely the failure mode the
project exists to catch, found in the project's own instrumentation, by a test
whose span count did not match. The number was wrong; nothing was broken.

---

### D-012 · The provider is the AI SDK through the Vercel AI Gateway

Resolves D-002. Everything still sits behind `ModelClient`, so this is one
adapter file (`src/provider/ai-gateway.ts`) and reversible.

The reason is the product: the config matrix *is* the deliverable, and through
the gateway a matrix entry for `openai/...` costs exactly what an
`anthropic/...` entry costs — one string. A vendor-specific SDK would make
cross-vendor comparison a second integration.

The adapter is deliberately **single-step**: tools are declared without an
`execute`, so the model returns its tool calls rather than running them. The
agent loop stays ours, which is what lets the recorder put a span around each
individual model and tool call. Handing the loop to the SDK would collapse a run
into one opaque span and make replay impossible.

**Reverses if:** we need a provider feature the gateway does not pass through.
Then a first-party adapter joins it rather than replacing it — the matrix wants
both.

---

### D-013 · Sampling decides persistence, not capture

`record()` always returns the complete trace; the sampler only decides whether
it reaches the store. A caller that wants this request's trace gets it whatever
the policy says.

The policy keeps every errored run and every run tagged `flagged`, regardless of
rate, because those are exactly the traces worth freezing into test cases — the
happy path is the part that is safe to sample. The decision is a hash of the
trace id rather than a random draw, so it is reproducible and the tests can
assert real rates instead of tolerating flake.

---

### D-014 · Cost is computed from a real price table, including promotional rates

`src/provider/pricing.ts` carries published USD-per-million-token rates, cache
multipliers (read ×0.1, write ×1.25/×2), and promotional pricing with an expiry
date — `priceFor(model, at)` resolves which applied on a given day. A report
comparing runs weeks apart otherwise silently mixes two price regimes.

Two details that would each have produced silently-wrong numbers:

- **Id spellings differ.** The gateway writes `anthropic/claude-opus-4.8`; the
  first-party API writes `claude-opus-4-8`. Same model. Without normalising,
  every gateway-run trace prices at zero.
- **Cached tokens must not be double-charged.** The AI SDK reports non-cached,
  cache-read, and cache-write input tokens separately; whether the headline
  `inputTokens` already includes the cached portion varies by provider. The
  adapter prefers the explicit non-cached count and only falls back to
  subtracting.

An unpriced model yields cost 0 with `costUnknown: true` rather than a
confident-looking free run.
