# Flight Recorder

An evaluation and regression harness for LLM agents. It records real agent
runs, freezes them into replayable test cases, and blocks any change that
quietly makes the agent worse.

> **Status: phase 2 of 8 complete.** Record → store → **freeze** → replay →
> check. Traces go to a transactional SQLite store with payload dedupe; test
> cases are auto-proposed from a recording and committed to git. No LLM judge,
> no statistics, no CI gate yet. See [docs/PHASES.md](docs/PHASES.md).

## Why

Conventional software fails loudly. Agent software fails *quietly* — you change
a prompt or bump a model, the agent keeps answering fluently, and it is now
wrong 8% of the time. Nothing throws. You find out from a customer.

Full rationale, architecture and build plan: [docs/spec.html](docs/spec.html).

## Quickstart

Requires Node 22.6+ (25 recommended — it runs TypeScript directly).

```bash
npm install
npm test          # 70 tests
npm run typecheck
```

Record a run, freeze it into a test case, then replay under a degraded
configuration and check the case against it:

```bash
npm run fr -- record                       # capture a good run
npm run fr -- freeze <trace-id>            # propose assertions, write a case
npm run fr -- replay <trace-id> degraded   # re-run under a worse config
npm run fr -- check <case-id> <new-trace>  # evaluate the case
```

No API key needed, at any phase. The default provider is a deterministic mock;
add `--provider ollama` for real local models.

## What the demo shows

The baseline agent verifies its arithmetic with a tool and answers `18.33%`.
The degraded one skips verification and answers `roughly 25%`. It does not
error. It does not throw. It reads as confident, fluent English — and it is
**33% cheaper and 33% faster**, so anything optimising on cost alone would
promote it.

Freezing the good run proposes nine assertions with no hand-authoring, because
`18.33` appears in both the calculator's output and the final answer — which
makes it a checked fact rather than a claim. Checking that case against the
degraded run gives:

```
FAIL  tool_called(calculate)   called: search
FAIL  output_contains(18.33)   "18.33" absent from the output
pass  max_steps(7)             3 steps (limit 7)
pass  max_cost_usd(0.00173)    $0.000774 (limit $0.001730)
pass  max_wall_ms(54)          13ms (limit 54ms)
```

Every resource check passes. Only the semantic ones catch it. That is the
failure mode this project exists to catch.

## Where things live

Traces are data and live in `.flightrecorder/traces.db` (local, gitignored).
Test cases are code and live in `flightrecorder/suites/*.json` (committed, and
reviewed in a pull request like any other test). See
[DECISIONS D-017](docs/DECISIONS.md).

## Commands

| Command | Does |
|---|---|
| `fr record [good\|degraded]` | Run the demo agent (`--provider mock\|ollama\|gateway`, `--model`) |
| `fr ls [limit]` | List stored traces |
| `fr show <trace-id>` | Print one trace with its spans |
| `fr replay <trace-id> [quality]` | Re-run a trace's input under a new config |
| `fr diff <baseline> <candidate>` | Naive side-by-side — **not** scoring |
| `fr freeze <trace-id>` | Promote a trace to a test case (`--suite`, `--drop`, `--tag`) |
| `fr cases [--suite name]` | List frozen cases |
| `fr check <case-id> <trace-id>` | Evaluate a case's assertions (tier 1 only) |
| `fr models` | List locally available Ollama models |
| `fr price [YYYY-MM-DD]` | Cost table, with promotional rates resolved |
| `fr stats` | Store size and dedupe savings |

## Real models, no API key

The whole project runs on local models. No key, no metered spend, offline.

```bash
brew install ollama && ollama serve &
ollama pull llama3.2:3b
ollama pull qwen2.5:7b

npm run fr -- models                                  # list what's available
npm run fr -- record --provider ollama --model qwen2.5:7b
```

A hosted provider is still supported for anyone who wants one — set
`AI_GATEWAY_API_KEY` (see `.env.example`) and pass `--provider gateway`. It is
one row of the matrix, not a prerequisite.

### What two local models already show

Same agent, same question, same prompt:

| | llama3.2:3b | qwen2.5:7b |
|---|---|---|
| Answer | **11.11%** | **18.33%** |
| Looked the figures up? | no | yes |
| Numbers used | `450`, `500` — invented | 1,200,000 → 1,420,000 |
| Wall time | **2.2s** | 10.4s |
| Tokens | **539** | 1,105 |
| Grounded claims | **0 of 3** | 1 of 1 |

The 3B model is 4.6× faster, uses half the tokens, and is confidently wrong.
Every resource metric prefers it. That is the entire argument for measuring
quality and cost together.

## Observability

The recorder emits OpenTelemetry spans using the GenAI semantic conventions, so
traces land in any collector you already run. With no OTel SDK registered it is
a no-op and costs nothing.

The `Trace` object is assembled separately from those spans, on purpose: a
telemetry pipeline may sample and drop, and a test fixture may not. See
[DECISIONS D-010](docs/DECISIONS.md).

## Layout

```
src/core/       the seven objects everything is built from
src/otel/       GenAI semantic conventions + test tracing
src/provider/   ModelClient seam, mock + Ollama + AI Gateway adapters, cost table
src/recorder/   span capture, redaction, sampling, trace assembly
src/store/      trace storage — SQLite (default) and filesystem
src/freeze/     assertion proposal, evaluation, suite files
src/replay/     record and replay entrypoints
examples/       demo + nested agents used as the harness's test subjects
flightrecorder/ committed test suites
docs/           spec, phase checklist, decision log
```

## Working on this

- [docs/PHASES.md](docs/PHASES.md) — what is done, what is next, exit criteria
- [docs/DECISIONS.md](docs/DECISIONS.md) — every design call and what would reverse it

One thing is still open, and it is not delegable: the ~200 human labels the
judge calibration depends on in phase 4. Without them the judge is an LLM
graded by an LLM, which is exactly the failure that tier exists to catch. The
labelling itself needs no API key.

The hosted gateway adapter has still never made a real API call — it is unit
tested but unexercised. That is deliberate: nothing in the project requires it.
