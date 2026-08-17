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

**Observation worth keeping for the writeup:** the degraded run is 59% cheaper
and 32% faster than the correct one, because skipping verification skips a
model call and a tool call. *(Figures corrected. This entry said "33% and 33%"
from phase 0 until a review re-derived them: true when written, made stale by
6e424b0, which restored the verification instruction and lengthened the v1
prompt. $0.001902 → $0.000774 today.)* Any optimiser tuned on cost or latency alone would
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

### D-009 · Filesystem store now, SQLite in phase 2 — **partly superseded by D-015**

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

---

### D-015 · One transactional SQLite file, using Node's built-in driver

Supersedes the storage half of D-009. `node:sqlite` ships with Node 22.6+, so
this needs no dependency and no native compile step — better than the
`better-sqlite3` the spec assumed, purely because it did not exist as a
practical option when the spec was written.

The bigger change is that traces, payloads and the index now live in **one
transactional file** rather than an index plus loose blobs. The phase-0 store
needed defensive code for "the index references a blob that is not there"; that
state can no longer exist, and the whole store is one file to copy or delete.

`FsTraceStore` stays. Two implementations behind one interface is what proves
the interface is real, and the phase-2 tests run the same contract against both.

**Reverses if:** payloads grow past what belongs in a local file and want object
storage. That is an implementation swap behind `TraceStore`, not a redesign.

---

### D-016 · Payloads are extracted bottom-up

Deduplication walks each value from the leaves upward, extracting any subtree
over the threshold. Direction is the whole trick.

Top-down would extract each span's entire input as one payload — and every
span's input is unique, so it would dedupe nothing while adding indirection.
Going upward, the repeated system prompt and tool schemas are extracted first,
and the wrapper that contained them is then small enough to stay inline. The
part that actually repeats is the part that gets shared.

Measured on twelve identical demo runs: 5 unique payloads backing 60 references,
43% smaller than storing them inline.

---

### D-017 · Traces are data, cases are code

Traces live in the database: large, numerous, machine-written, nobody reviews
them. Test cases live in a committed JSON file under `flightrecorder/suites/`:
small, few, human-approved, and a change to one should show up in a pull request
exactly like a change to a unit test.

The file is written with a fixed key order and stable formatting, because what
makes a file reviewable is that its diff shows only what actually changed.

---

### D-018 · The evaluator lives with the freezer, not the scorer

Phase 4 owns scoring, so tier-1 evaluation nominally belongs there. It is here
because the proposer cannot be correct without it: an assertion proposed from a
trace that does not hold *on that trace* is a bug in the proposer, and the only
way to know is to run it. `freeze()` therefore evaluates every assertion against
its source and throws `InvalidProposalError` rather than writing a case whose
baseline fails — which would poison every report built on it.

Phase 4's tiered scorer builds on this, rather than beside it.

---

### D-019 · Assertions are proposed from what the run verified

The proposer's best heuristic: take the literals in the final answer, and keep
the ones that also appear in some tool's output. A number the agent's own tool
produced is a **checked fact**; a number that appears nowhere else is a claim the
model asserted on its own. Pinning the first kind is safe and catches exactly the
failure this project exists to catch.

On the demo, this auto-proposes `output_contains("18.33")` — and the degraded
agent, which skips the calculator and answers "roughly 25%", fails it without
anyone writing a line of test code.

The same analysis is shown at freeze time as verified/unchecked claims, which is
useful on its own — it tells you how much of an answer the agent actually
checked.

**Superseded in part by D-021**: presence in a tool output turned out not to be
sufficient, and the matching rule changed from substring to whole-token.

---

### D-020 · Ollama is the default provider; no API key is required to run this

The project runs end to end on local models with zero external spend. A consumer
chat subscription does not grant programmatic API access — those are separately
billed products — and a harness whose development requires metered inference is
a harness that does not get developed.

For a *regression* harness the subject model's intelligence matters much less
than it appears to. What the fixtures need is runs that call tools and can
plausibly get worse. An 8B model regresses just as legibly as a frontier one,
and does it for free, unlimited, offline.

The adapter talks to Ollama's native `/api/chat` rather than its
OpenAI-compatible endpoint. The native shape reports true prompt and eval token
counts, and writing a second adapter against a genuinely different wire format
is what proves the `ModelClient` seam is real rather than an OpenAI schema in
disguise.

Local inference reports `costUsd: 0` with `costUnknown: false` — it is unmetered,
not unpriced, and those are different claims. The gateway adapter stays for
anyone who wants hosted models; it is now one row of the matrix rather than the
foundation.

**This also gave the matrix its second real axis.** Local versus hosted moves
quality, cost and latency simultaneously, which is exactly the three-way
tradeoff the report exists to make visible. Before this, the matrix could only
vary prompts.

---

### D-021 · Verification follows provenance, not presence

Supersedes the matching rule in D-019. A tool's output counts as evidence only
if the tool's own inputs were themselves grounded — in the user's question, or
in an earlier grounded tool output. Otherwise the tool faithfully computed
something from numbers the model invented, and its output launders a
hallucination into an apparently checked fact.

**This was not a hypothetical.** Asked for quarterly growth, `llama3.2:3b`
skipped the lookup entirely, called the calculator with `450` and `500` — values
it made up — and answered "11.11%". Arithmetically correct. Completely
fabricated. And under D-019's presence-only rule, `11.11` appeared in the
calculator's output, so the proposer would have pinned it as a verified fact.

The same question to `qwen2.5:7b` produced a correct 18.33% via a real lookup.
Under the provenance rule the first run has zero grounded literals and the
second has one, which is the right answer to a question the previous rule got
backwards.

Two supporting changes:

- **Whole-token matching, not substring.** `1,420,000` and `1420000` normalise
  to the same number, so comma variants match; but `1.2` no longer matches
  inside `1,200,000`, because tokens are compared whole. This is strictly better
  than D-019's rule in both directions.
- **Small integers are exempt from grounding.** The `100` in a percentage is
  arithmetic scaffolding, not a claim about the world. The ceiling is 100 and
  configurable. `450` and `500` are above it and are correctly treated as
  claims.

Worth keeping for the writeup: the flaw was invisible against the scripted mock
and surfaced within minutes of pointing the harness at a real small model. The
fixture that looked adequate was testing the fixture.

---

### D-022 · A stub miss is answered, not thrown and not executed

When a candidate calls a tool the baseline never called, stubbed mode returns a
legible marker string and records the miss. The two obvious alternatives are
both worse:

- **Throwing** aborts the run and hides everything the model would have done
  next, which is exactly the part worth seeing.
- **Falling through to the real tool** silently makes it a live call and
  destroys the one property stubbed mode exists to provide.

Divergence is graded rather than binary, because a candidate does not have to
use tools the way the baseline did and *how* it differs is the finding:

| | meaning |
|---|---|
| `exact` | same tool, byte-identical input |
| `positional` | same tool, different arguments — the model asked differently |
| `miss` | no recording at all — the model went somewhere new |
| `unused` | the baseline called it; the candidate did not |

The interception seam lives on the `Recorder` rather than in the replay layer,
which is what lets the same hook serve the Docker sandbox (D-024).

---

### D-023 · A matrix cell's identity is (case, config, mode)

That triple is `UNIQUE` in the attempts table, which makes resumption a lookup
rather than bookkeeping and makes re-running one cell idempotent. A 150-cell run
that dies at cell 140 resumes; in practice a re-run of a finished matrix costs
0.38s instead of 30s of inference.

Two rules the runner holds to:

- **An unrunnable cell keeps its slot.** Dropping it would silently shrink the
  denominator and make the pass rate look better than it is.
- **An agent failure is a result, not an error.** If the agent throws, the trace
  records it and the cell completes. Only failures that escape `record()` reach
  the retry path — so a bad expression is recorded once, not three times.

Retry classification is deliberately conservative: an unrecognised error is
treated as real. Retrying a genuine failure triples the cost of learning the
same thing.

---

### D-024 · The Docker sandbox is opt-in per tool, and says so

Live tool execution can run in a container: network denied, read-only root,
capabilities dropped, memory capped, hard timeout. It is tested against real
containers rather than mocked.

It is **not** applied to every tool, and that is a scope decision rather than an
omission. The demo agent's tools are pure in-process functions; wrapping one in
a container would add latency and prove nothing. The sandbox exists for tools
that shell out — the shape phase 07's open-source agent is likely to have — and
declaring which tools need it is a one-line configuration.

It reuses the `ToolInterceptor` seam from D-022, which is the payoff of putting
that hook in the recorder: one mechanism serves both "answer this from a
recording" and "run this where it cannot do damage".

---

### D-025 · A test case records which agent it exercises

`TestCase` carries an `AgentRef`, and the registry resolves that name back to
code. A case is inert data and cannot hold a function, so without the name a
suite is unrunnable on its own — you would have to guess what it was testing.

This is the seam phase 07 uses: pointing the harness at an open-source agent is
a registration, not a rewrite.

---

### D-026 · Pairwise, not absolute, and the presentation order is fixed by hash

Asking a model "is B better than A" is far more stable than asking it to score
one answer out of ten, and it maps directly onto the question a regression
report asks: did this change make things worse?

Position bias is large enough to invent a winner on its own, so which answer is
shown as A is decided by a hash of the item id. That is unbiased across the set
and identical every time the same item is judged — a verdict that changes on
re-run is not a measurement. `measurePositionBias` runs both orders and reports
the flip rate, so the bias can be quantified rather than assumed away.

An unreadable judge reply becomes a **tie, flagged `unparsed`**. Guessing a
winner out of noise would put fabricated signal into the report, and the
calibration run needs to see how often the judge fails to answer at all.

---

### D-027 · A tie is a pass

The harness asks whether a change made things worse, not which answer is best.
A judged tie means the candidate did not regress, so it passes with a score of
0.5; only the baseline winning is a failure.

---

### D-028 · Deterministic verdicts carry no trust caveat; judged ones cannot be trusted by default

A tier-1 verdict is not an opinion — an assertion either held or it did not — so
its `trust` is `null` and the report presents it as fact.

A judged verdict carries the judge's kappa from the most recent calibration.
**An uncalibrated judge is untrusted**, not assumed good: `trust: null` on a
judged verdict fails the trust check. The default has to fall that way, because
the failure mode this tier exists to prevent is exactly a confident number
nobody measured.

---

### D-029 · Labelling is blind, and labels are committed

The labeller sees "Answer 1" and "Answer 2" with the order fixed per item and
recorded. Knowing which was the baseline would anchor them, and the ground truth
the judge is measured against would then carry the same bias the judge is
suspected of.

Labels live in `flightrecorder/labels/`, in git, beside the suites. They are the
most expensive data in the project — a person read two answers and decided — and
the only part nobody can generate. The labelling command saves after every
single label, because a crash must never cost someone's afternoon.

Identical pairs are never queued: they carry no information either way, and
spending a human's attention on them is the fastest way to make them stop.

---

### D-030 · Calibration refuses to report kappa below n=30

Kappa on a handful of pairs has an interval wide enough to span "worse than
chance" to "substantial", and a number like that invites exactly the
over-claiming this project exists to argue against. Below 30 labels
`calibrate()` throws rather than returning something quotable.

Above it, kappa always ships with a bootstrap interval. The threshold to act on
is 0.6; below that the report marks judged verdicts untrusted rather than
presenting them as fact.

---

### D-031 · The comparison is paired, so cases are the unit of resampling

Every case runs under both configs, so the bootstrap resamples *cases*, not
observations. Treating 40 baseline results and 40 candidate results as two
independent samples throws the pairing away and widens every interval for
nothing — and on a suite where some tasks are simply harder than others, that
pairing carries most of the signal.

---

### D-032 · The headline refuses to name a direction it cannot support

When the interval spans zero the report says *"no detectable change: +5%
(−4% to +13%), not significant at n=40"* and stops. It does not say "improved".

Those are different claims and only one of them is supported by two flipped
cases. The exit criterion for this phase is a test asserting exactly this, and
it also asserts the headline contains neither "rose" nor "fell".

---

### D-033 · Quality, cost and latency are reported side by side, never separately

This project's own evidence is that resource metrics prefer the broken agent:
the degraded mock is 33% cheaper, and a 3B model that fabricates its figures is
4.6× faster than the one that looks them up. A report that led with cost would
recommend the wrong thing every time.

So the metrics table puts all three in one view with their intervals, and the
headline is always the quality number.

---

### D-034 · The step diff compares decisions, not identities

A model span is compared by *what it asked for* — which tools it requested —
never by the model's name or its prose.

The first version compared span names, and on a cross-model report every step
differed for the trivial reason that the model **is** the change: the diff said
"the baseline called qwen2.5:7b, the candidate called llama3.2:3b" twenty-five
times and explained nothing. Comparing prose is no better, since two correct
answers rarely share wording and both answers are already shown above the diff.

What remains is the path the agent took, which is the part that explains a
regression. On real data it now reports, unprompted:

> The runs diverge immediately: the baseline asked for search, the candidate
> asked for calculate.

That is llama3.2:3b's entire failure mode — skip the lookup, do arithmetic on
invented numbers — stated in one sentence across 20 of 25 cases, with nobody
reading a trace.

---

### D-035 · A pair with an empty side never reaches the labeller

Found by labelling for real: 28 of the first 49 pairs had a blank candidate,
because that run errored and produced nothing.

Those pairs are not judgement calls. "An answer beats no answer" is obvious to
the human and equally obvious to the judge, so queueing them does two bad
things: it spends a person's attention on freebies, and it **inflates kappa** —
human and judge agree perfectly on every one of them for reasons that have
nothing to do with how well the judge judges.

The pool already skipped *identical* pairs for exactly this reason. An empty
side is the same problem and was simply missed. An errored run is tier 1's
job — `no_error` catches it without an opinion.

**The error rates that produced them are worth keeping:**

| model | errored |
|---|---|
| qwen2.5:7b | 0 / 60 |
| llama3.2:3b | 13 / 30 |
| llama3.1:8b | 26 / 30 |

The larger llama fails nearly nine times in ten on this task. Bigger is not
better, and a harness that only reported averages would have hidden it.

---

### D-036 · Prompt version is a matrix axis, because it is the axis that regresses

`RunConfig.promptVersion` existed from phase 0 but the demo agent ignored it, so
the matrix could only vary models. That is the wrong half: in practice prompts
regress far more often than models change.

It is also where the useful calibration pairs live. A weaker prompt on a
reliable model produces *complete but worse* answers — genuine judgement calls,
where a model swap tends to produce either an identical answer or a crash.
`--prompts v1,v0` now crosses prompt variants over models and temperatures.

The v0 variant is not a strawman. It is the prompt this project actually started
with, and it is what a real prompt looks like before someone has watched it
fail: it never says where numbers come from, or that expressions must contain
literals rather than variable names.

**A correction, and how it was caught.** This entry first claimed qwen "scores
83% under v0 and 82% under v1, so the prompt barely touches it". That compared
the wrong things: the 82% was qwen at *temperature 0.9* under v1, not the v1
baseline at all. Running the gate is what surfaced it.

The real comparison, v1 → v0 at the same temperature, is a **20% drop in case
pass rate (−36.7% to −6.7%, significant at n=30)** across 6 regressed cases, and
p95 latency going from 9.5s to 50s because the weaker prompt makes the model
loop.

Two things worth keeping from that:

- **Assertion rate hid it.** 132 of 159 assertions still pass under v0 — 83%,
  which reads like almost nothing. But a case passes only if *every* hard
  assertion holds, and at case level it is a fifth of the suite. This is the
  argument for reporting case pass rate rather than an assertion average, and
  for reporting latency beside it.
- **I made exactly the error the tool exists to catch**: quoted a flattering
  aggregate, compared two things that were not comparable, and concluded there
  was no regression. The harness disagreed.

---

### D-037 · The gate blocks on significance, not on direction

A negative delta is not a reason to fail a build. A *significant* negative delta
is. Blocking on a one-case dip in forty trains people to override the gate, and
a gate that gets overridden by habit protects nothing.

Two deliberate exceptions to statistical caution:

- **A `p0` regression fails on its own**, whatever the aggregate says.
  Statistics are the wrong instrument for "the billing flow broke" — some cases
  are load-bearing enough that one failure is the answer.
- **`--fail-on-any-regression`** exists for suites large enough that any
  regression is signal, but it is off by default.

**Untrusted verdicts never block.** If the judge is not calibrated well enough
to be presented as fact, it is not calibrated well enough to fail someone's
build. The gate counts them, reports them, and decides without them.

---

### D-038 · A suite that only runs on its author's laptop is not a fixture

Every case points at a `baselineTraceId` living in a gitignored database, so a
committed suite was unrunnable on a fresh clone — it failed with "trace not in
the store". `fr export` writes the traces a suite depends on into a committed
JSON bundle; `fr import` loads them back; `fr doctor` says whether the suite can
run here at all.

The CI workflow runs `import` then `doctor` on every push, so the portability
claim is checked rather than assumed — that is the phase 7 criterion ("npm i to
first report on someone else's machine") tested continuously instead of once.

**Pinning refuses on a dirty tree.** `currentCommit()` returns null rather than
a hash when `git status` is not clean, because a baseline pinned to a commit
that does not describe the working tree looks reproducible without being so,
which is worse than an honest absence of a pin.

---

### D-039 · The judge's prompt is a config, and v1 was actively harmful

Calibrated against 47 human labels, three judges:

| judge | prompt | κ | 95% CI | verdict |
|---|---|---|---|---|
| qwen2.5:7b | v1 | **−0.102** | (−0.203, −0.008) | worse than chance |
| qwen2.5:7b | v2 | **0.209** | (0.001, 0.409) | fair |
| llama3.1:8b | v2 | 0.089 | (−0.117, 0.307) | not distinguishable from chance |

**v1 was significantly worse than a coin flip.** Its interval excludes zero, so
that is a measurement, not noise. The confusion matrix said why, and the judge's
own reasons said it out loud:

> "Answer B provides supporting details that confirm the…" — preferring the run
> that invented 450 and 500
> "Answer B provides a calculation supporting the figure" — preferring fabricated
> working
> "Answer A shows the calculation, while Answer B only states…" — preferring the
> run that printed a tool call as prose and computed nothing

**The judge was rewarding the appearance of work.** Fabricating models produce
more text, more visible arithmetic, more apparent rigour — and the judge read
that as quality. It preferred hallucinations, systematically.

The prompt was partly responsible. v1 said *"correct, complete and supported by
the work shown"*, and a fabricated calculation satisfies "work shown" perfectly.
The instruction rewarded the exact behaviour it was meant to detect.

It also **never once said TIE** — zero times in 47, against a human who said it
21 times. The pairs that looked like filler while labelling (same model, two
prompts, same correct answer) are what exposed that. A pool of only obvious
cases would have hidden it behind a flattering agreement score.

v2 addresses all three failures explicitly and moves κ by **0.31** on the same
model and the same labels. **The prompt mattered more than the model** — the
larger llama scored worse than qwen under identical instructions.

v1 is kept rather than deleted, because that is what makes the improvement
measurable rather than asserted.

---

### D-040 · Calibrations are comparisons, so they are never overwritten

Running a second calibration silently destroyed the first, which is exactly the
number you want to compare against. `writeCalibration` now appends every result
to `<set>.calibrations.jsonl` alongside the current file the report cites.

Found by running three calibrations in a row and watching the evidence for the
first two disappear.

---

### D-041 · The open-source agent is LangGraph's prebuilt ReAct loop, reached through a chat-model bridge

Phase 7's claim is that the harness records and regresses an agent this project
did not write. The loop under test is `createReactAgent` from
`@langchain/langgraph` — the most widely deployed open-source agent loop in the
JS ecosystem. It decides when to call tools, how to route results, when to
stop, and how to recover from a tool error; none of that logic is ours.

**What is ours, stated precisely:** the two domain tools and the prompt
variants (deliberately identical to the demo agent's, so comparing the two
agents compares *loops* rather than tasks), and the bridge —
`src/provider/langchain-bridge.ts`, a `BaseChatModel` whose `_generate`
delegates to the harness's `ModelClient`.

The bridge is the entire integration surface, and it is why no other part of
the harness changed: the model calls of the foreign loop arrive through the
recorder-wrapped client, so model spans, usage, stubbed replay and the sandbox
all apply unchanged. Registering the agent was one line. That was the promise
of the `RecordableAgent` seam, and this is the test of it.

**Alternatives rejected:** Python agents (AutoGPT-descendants, smolagents,
CrewAI) would need an HTTP recording proxy and a subprocess runner, and their
tools execute out of reach of the stub interceptor — stubbed replay would die.
Vercel AI SDK's tool loop would work the same way as LangGraph but is less
recognisable as "an agent someone else wrote".

**Version facts that bit, recorded for the next reader:** in the installed
`@langchain/core` 1.2.7, `Runnable.bind()` no longer exists (`withConfig` is
the only binding mechanism); `bindTools` has no default implementation and
bound tools reach `_generate` only via a caller-declared CallOptions field; the
system-prompt param on `createReactAgent` is now `prompt` (`stateModifier` and
`messageModifier` are deprecated); `AIMessage.tool_calls[].args` is a parsed
object, not a JSON string. All four were extracted from the installed type
definitions rather than remembered, and all four would have been plausible
sources of silent conversion bugs.

**One behavioural difference observed, not suppressed:** our hand-rolled loop
lets a tool error abort the run, while LangGraph's ToolNode catches it and
hands it back to the model to retry. Neither is wrong. The harness records
what happened; the tool-error span is still captured either way.

---

### D-042 · A recorded failure replays as a failure

Found by adversarial review of the phase-7 integration, and it is the most
important defect the project has caught in itself since the judge.

The stub served only `span.output`, ignoring `span.error`. A tool call that
*failed* on the baseline therefore replayed as a successful `null` — which
LangChain stringifies into a ToolMessage containing the text "null" with
status *success*. The candidate model saw "null" where the live model saw the
error text, the conversations silently diverged, and the stub report still
claimed `identical: true`. The one guarantee stubbed mode exists to provide —
the environment held perfectly still — was broken precisely on the runs where
it matters most.

The foreign agent is what made this reachable. Our hand-rolled loop lets a
tool error abort the run, so an errored span always came with `trace.error`
set and such traces never became clean baselines. LangGraph's ToolNode catches
the error, feeds the text back to the model, and the run *recovers* — a clean,
freezable trace containing an errored span. The defect sat unreachable for
four phases until an agent with different error semantics arrived.

The recording of a failure is still a recording of the environment. The stub
now rethrows recorded errors with the recorded message, so a recovering agent
sees the identical error text on replay and a non-recovering agent aborts
identically. Pinned by tests for both agent shapes.

---

### D-043 · The temperature axis was dead, and its ghost is in this log

Both example agents hardcoded `temperature: 0` in their model calls, so the
matrix's temperature axis — `qwen2.5:7b@0.9` — changed the config id and
nothing else. Every request carried 0 regardless.

Two consequences already in the record:

- The calibration pool generation noted "41 skipped as duplicate or identical"
  — because the `@0.9` runs *were* the temp-0 runs, byte for byte.
- D-036's correction states the miscompared 82% figure was "qwen at
  temperature 0.9". It was qwen at temperature 0, labelled 0.9. The
  correction's substance stands — the configs were not comparable — but its
  explanation named an axis that did not exist.

`AgentContext` now carries `temperature` from the config, both agents use it,
and a test asserts the request temperature equals the config temperature for
both loops. This is the third instance of the same failure class caught by
this project (model in phase 3, prompt in phase 6, temperature now), which is
an argument for the context object being the *only* way agents receive config.

---

### D-044 · The loop is a quality parameter for models that make mistakes, and invisible for models that don't

*Twice corrected. The first version of this table was a rate over a fraction of
the suite (D-045); the second included 23 runs that died because the model
daemon was down (D-046). The finding below is the one that survived both — and
it is a different, narrower claim than either of them.*

30 identical tasks, identical tools, identical prompts, identical temperature —
only the agent loop differs. Both loops' traces are scored against **one**
assertion set (the metrics suite's, frozen from the hand-rolled baseline),
matched task by task, because each suite's own assertions are a different ruler.
Reproduce with `node scripts/loop-compare.ts`:

| live runs | hand-rolled | LangGraph ReAct |
|---|---|---|
| llama3.2:3b hard assertions | 78/129 · 60% | **91/129 · 71%** |
| llama3.2:3b runs that died | 13 of 30 | **0 of 30** |
| qwen2.5:7b hard assertions | 125/129 · 97% | 125/129 · 97% |
| qwen2.5:7b cases passed | 27/30 | 27/30 |

Two results, and the second is the interesting one.

**The weak model gains eleven points and stops dying.** It emits 13 failed tool
calls across its 30 live runs under *either* loop — the model's mistakes are the
model's, and the loop does not change them. LangGraph's ToolNode catches each
error and hands the text back for a retry; our loop lets it abort. Same
mistakes, different consequences: 13 dead runs become 0.

**The strong model is completely indifferent to the loop** — 97% either way, the
same 27 of 30 cases, no errored tool calls to recover from. Every millisecond of
retry machinery is dead code on a model that gets its arguments right.

So the loop is not a quality parameter in general; it is a *recovery* parameter,
and it pays exactly in proportion to how often the model errs. That is a much
narrower claim than "ReAct is better", and it is the one the data supports. It
also predicts where the difference should appear and where it should not, which
is the property that makes it worth publishing.

The honest caveat: the tasks and tools are ours, so this measures how two loops
handle *our* tools' errors rather than making a general claim about LangGraph.
What transfers is the method — hold the model, prompt, tools and temperature
still, vary the loop, score both against one ruler.

Also observed: in stubbed mode the difference vanishes for the weak model too
(77% hand-rolled against 76% ReAct, no deaths under either). Positional matching
serves the baseline's recorded — correct — call even when the candidate's
arguments were malformed, so the stub never lets the failure happen and there is
nothing to recover from. Stubbed mode holds the environment still, and a tool
error *is* the environment. Worth a line in any report read across modes.

---

### D-045 · The matrix reported a rate over whichever cells happened to run today

Found by trying to reproduce D-044's own published table and failing.

The CLI's tier-1 summary iterated the matrix results and skipped any cell
without a trace — and `runMatrix` gave a *resumed* cell its stored `Attempt`
but left `trace: null`. So on a resumed run, which is every run after the first
one, the printed rate covered only the cells that had not already finished. The
120-cell react matrix printed `23/32` and called it the assertion rate; the
figure that reached D-044, PHASES and the README as "64% under the hand-rolled
loop" was a rate over a fraction of the suite, chosen by which cells happened to
be unfinished that afternoon.

Nothing errored, the denominator was printed honestly, and the number was
wrong. Same shape as every other defect on this project's list, and this one is
in the reporting path — the part whose whole job is to be trustworthy. It also
sat directly beneath a comment in `matrix.ts` explaining that a failed cell must
keep its slot because "dropping it would silently shrink the denominator."

A second, smaller version of the same mistake sat two lines below it: the
summary bucketed cells by model and mode, so a matrix crossing prompts averaged
`v1` and `v0` into one row. The gate self-test's own matrix printed **78%** —
the mean of a healthy config at 100% and a deliberately broken one at 56%. It is
now keyed by the whole config, which prints both.

Resumed cells now carry their recorded trace, so every rate covers the full
matrix, and a test asserts a resumed run returns the same trace ids as the run
that recorded them. Corrected figures are in D-044; the cross-loop comparison is
now a committed script (`scripts/loop-compare.ts`) rather than a console line
copied into prose, because a number nobody can re-derive is a number nobody
should have to believe.

---

### D-046 · An outage is not a result: the matrix cached 23 runs that died because the daemon was down

Found immediately after D-045, by recomputing the corrected table and reading
the error messages instead of the totals.

23 of the 120 metrics-suite cells had died with `No Ollama daemon at
http://127.0.0.1:11434` — the model host was killed mid-run when a session was
interrupted, weeks ago. Every one had been stored as a completed `Attempt`,
resumed on every matrix run since, and counted in every rate computed from that
suite. They are not evidence about an agent; they are evidence that a laptop
process was not running.

The damage was not hypothetical. With the outage runs in, the corrected D-044
table read "the strong model gains 14 points under ReAct" and "20 of 60
hand-rolled runs died". With them out and the 23 cells actually re-run: the
strong model gains **nothing** — 97% under both loops — and the deaths were 13,
all of them the weak model's. The version I nearly published inverted the
finding, because a dead daemon looks exactly like a fatal agent failure to
anything reading `trace.error`.

The recorder is right to capture the failure — D-006 says a trace of a failed
run is written, and that stands. The matrix is what was wrong: it treated *the
harness could not run the agent* as *the agent failed*. `ModelClient` adapters
already name these errors (`OllamaUnavailableError`,
`MissingGatewayCredentialError`, `DockerUnavailableError`), so
`isEnvironmentFailure` now recognises them by type, the cell is retried and then
reported as one that could not run, and nothing is persisted — so the next run
re-runs it rather than serving the outage forever. Pinned by a test that fails a
cell with a dead daemon and asserts the following run records it for real.

**Reverses if:** a provider's unavailability is ever the thing under test. Then
it belongs in a case as an assertion, not as a silently cached attempt.

---

### D-047 · What an adversarial review of the corrections found

The corrections in D-045 and D-046 were themselves reviewed, adversarially, by
readers with no stake in them. They found four more defects — three of the same
family as the ones they were reviewing, which is the useful part.

- **The bucketing fix was half a fix.** D-045 changed the matrix summary's key
  from model+mode to model+prompt+mode. Temperature was still missing, so
  `--models qwen2.5:7b,qwen2.5:7b@0.9` still averaged two configs into one row —
  and D-043, in the same batch, is what made temperature reach the model at all,
  so the fix and the thing that armed the collision shipped together. Keyed by
  the config's identity now, in the matrix summary *and* in
  `scripts/loop-compare.ts`, which had the identical flaw in the artifact whose
  whole job is re-derivability.
- **D-046 was applied on write, never on read.** Refusing to store an outage
  protects stores this version creates; every attempt recorded before the fix was
  still being resumed and counted. The "forever" it claimed to have ended had not
  ended. The check now runs on resume too, so a poisoned store heals itself.
- **An outage inside a *tool* was still a result.** The environment check read
  only `trace.error`, but an agent whose loop catches tool errors — most of them,
  ours excepted — turns an unreachable sandbox into a clean trace with an errored
  span. That is D-042's asymmetry pointed at the environment instead of the
  model, and phase 7's whole premise is running third-party loops with
  third-party tools. Tool spans are checked now.
- **A gate that compared nothing reported PASS.** With `n = 0` the pass-rate
  delta is NaN, "not significant" is trivially true, and the build goes green —
  so `--baseline v1` (which parses `v1` as a *model* name) reads exactly like a
  clean bill of health. `report` already refused to print a row of NaN here; the
  gate was the half that stayed quiet, which is the more dangerous half. It now
  fails with the parsed config ids and the spec format. **This is the worst
  defect this project has found in itself since the judge**: a merge gate whose
  failure mode is silent approval is worse than no gate, because it is trusted.

The documentation review found the guide's CI snippet could not run as printed —
missing `FR_AGENTS`, a `gate` call without its required specs, and `--provider
mock` recommended for a reader's own agent when the mock is scripted to this
repo's demo. Plus a stale `max_cost_usd` and a "33% cheaper" that the prompt
restored in 6e424b0 had made 59%. All corrected against re-derived output.

**A known limit, recorded rather than fixed.** An `Attempt` is identified by
`(case, config, mode)` and records nothing about the harness that produced it, so
a change in *semantics* — D-042 changed what stubbed mode does with a recorded
tool failure — does not invalidate the results it makes wrong. Resume serves them
and the comparison script reports them as current. Benign today, because neither
suite's baselines contain an errored tool span (verified 0/30 in both), and that
is the only condition under which the old and new stub differ. It stops being
benign the first time a suite is frozen from a model that errs. The fix is a
semantics version in the attempt key; the reason it is not done yet is that it
invalidates every stored attempt on the first bump, and that trade is worth
making deliberately rather than at the end of a long night.

---

### D-048 · The judge reaches κ = 0.687, and the two changes that got it there only work together

Phase 4's criterion was κ ≥ 0.6 on 200 labelled examples. It sat published as
*unmet* at 0.209 for the rest of the project. It is now met on the point
estimate, at n = 47, and the road there produced a better finding than the
number.

**The judge was being measured blind against humans who had ground truth.**
`flightrecorder/answer-key.md` opens with "Keep this open while labelling", so
every one of the 47 labels was made by someone who knew the correct answer. The
judge saw two anonymous strings. Asked which of "18.33%" and "11.11%" is right,
with no data and no tools, its best available strategy is a coin flip — and κ
duly measured one. That is not a hard task, it is an impossible one, and the
tier had been quietly measuring an information gap rather than a judge.
`fr calibrate` now supplies the same key by default (`--rubrics false` to
reproduce the blind runs).

**The full experiment**, all on the same 47 labels, `qwen2.5:7b` unless stated:

| judge prompt | rubric | κ | 95% interval |
|---|---|---|---|
| v1 | blind | −0.102 | (−0.203, −0.008) |
| v2 | blind | 0.209 | (0.001, 0.409) |
| v3 — procedure, tie-first | blind | **0.459** | (0.276, 0.643) |
| v3 | answer key | 0.188 | (0.029, 0.350) |
| v4 — rubric fenced off from the tie test | blind | 0.459 | (0.266, 0.656) |
| **v4** | **answer key** | **0.687** | (0.474, 0.865) |
| v4 on `llama3.1:8b` | answer key | 0.654 | (0.472, 0.820) |

**Neither change works alone, and one of them backfires.** Handing v3 the answer
key *halved* its agreement, 0.459 → 0.188. The confusion matrix says exactly
why: on pairs that genuinely differ the rubric made it near-perfect (22 of 23,
against 11 of 23 blind), but its ties collapsed from 19 of 21 to 1 of 21. Given
a reference, the model starts grading each answer's *resemblance* to it, so the
answer that also shows the derivation beats the one that merely states the same
correct figure. That is the "detail is quality" failure from v1, returning
through a door the fix opened.

v4 is v3 with one paragraph added: the rubric is explicitly out of scope until
after the tie test. 0.188 → 0.687. **The instruction that needs to be hardest to
skip is the one the model is most motivated to skip.**

Method note, since it is the reusable part: v2 was written against v1's confusion
matrix, v3 against v2's, v4 against v3's. Four prompts, each one addressing the
single cell holding the most disagreement. No version was written from intuition
after v1, and v1 is the one that scored below chance.

**What this does not yet earn.** Three caveats, all pointing at the same
remaining work:

1. **The interval's lower bound is 0.474.** At n = 47 we cannot say with 95%
   confidence that the true κ clears 0.6, only that the point estimate does.
2. **The spec said 200 labels.** We have 47.
3. **v3 and v4 were written against these same 47 labels.** That is tuning on
   the test set, and the honest word for 0.687 until it is checked on unseen
   pairs is *provisional*. A judge prompt fitted to a confusion matrix can fit
   that matrix's noise as easily as its signal.

All three close with the same action: label a fresh set and treat it as held-out
validation rather than more training data. Until then the report keeps saying
what it has always said, only with a different number attached, and
`isTrustworthy` is doing the deciding rather than an opinion.

**Reverses if:** validation on unseen pairs comes back below 0.6, in which case
the honest headline returns to "not met" and v4 is recorded as overfitted — an
outcome worth having measured either way.

---

### D-049 · Held-out validation cut the judge from 0.687 to 0.429, and every disagreement but one is the same disagreement

D-048 called 0.687 provisional because prompts v3 and v4 were written against
the 47 labels they were scored on. A 42-pair validation set was pooled from the
ReAct suite — same 30 tasks, different agent, and the 17 pairs whose answer
texts also appeared in the tuned-on set were dropped, so nothing in it informed
either prompt. Labelled blind under the same protocol, with the same answer key.

**κ = 0.429 (0.187 to 0.662), raw agreement 71.4%.** Below the 0.6 bar. The
tuned number did not survive, and phase 4's criterion goes back to unmet.

**But the drop is not noise, and that is the finding.** 12 of 42 pairs
disagreed, and 11 of the 12 are one shape:

```
human \ judge    baseline      tie
baseline               10        1
tie                    11       20
```

Every one of those 11 is a candidate answer that gives the *correct figure*
propped up by *invented supporting numbers* — "grew by 40.00% over the year,
from 9,000 to 12,345", when the key says 145 → 203. The human called them ties:
same figure, question answered. The judge, holding the same key, saw a
derivation that contradicts it and called the clean answer better.

Rerun the same verdicts with that single rule aligned and **κ = 0.937 (0.780 to
1.000), raw agreement 97.6%**. One rule, eleven pairs, half a kappa.

**So this is a rule disagreement, not an accuracy failure — and the judge has
the better rule.** This repository's third defect was the assertion proposer
nearly certifying a hallucination because a fabricated figure appeared in a
tool's output; provenance-aware grounding exists precisely because invented
support is not neutral. The judge is applying that principle. The human label
was the weaker of the two.

That is worth stating plainly because it is a limit of the whole tier: **κ
measures agreement, not correctness.** A judge that is stricter than its
labeller is punished for it, and no amount of labelling fixes that — only a
labelling protocol precise enough to say what a tie *is*.

**What was deliberately not done.** Re-labelling those 11 pairs to match the
judge would produce a number above 0.6 and mean nothing: that is grading to the
test, and it is the exact move this tier exists to detect. Rewriting v4 into a
v5 that ties on any matching figure would fit the human's rule at the cost of
the behaviour that makes the judge useful, and would then need a *third* fresh
set to validate honestly.

**Where this leaves the number.** Two measurements, both published: 0.687 on the
set the prompt was written against, 0.429 on a set it was not. The second is the
one that counts. Judged verdicts stay marked untrusted, the gate keeps refusing
to block on them, and the deterministic tier keeps doing the work.

**Reverses if:** the labelling protocol is tightened to define a tie explicitly
— figure only, or figure plus support — and a fresh set is labelled under it. A
judge and a human applying the same written rule is the only version of this
measurement that means what it claims to.
