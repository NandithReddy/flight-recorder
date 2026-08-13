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

### D-002 · The provider is deliberately undecided

Everything talks to `ModelClient` in `src/provider/types.ts`. Adding Anthropic,
OpenAI, or the Vercel AI Gateway later is one adapter file and touches nothing
else.

**Open question — needs answering before phase 04.** The judge is the only
component with a real opinion here: it wants a strong model and predictable
tool-free structured output. The AI Gateway is attractive because the config
matrix is the product, and varying a `provider/model` string across vendors is
free.

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
