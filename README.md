# Flight Recorder

An evaluation and regression harness for LLM agents. It records real agent
runs, freezes them into replayable test cases, and blocks any change that
quietly makes the agent worse.

> **Status: phases 0–3 and 5 complete, phase 4 built.** Record → freeze → run
> the matrix → score → **report**, with confidence intervals and a step diff
> that names the diverging decision. The judge's trust score is waiting on human
> labels — the one thing the harness must not generate for itself. CI gate next.
> See [docs/PHASES.md](docs/PHASES.md).

## Why

Conventional software fails loudly. Agent software fails *quietly* — you change
a prompt or bump a model, the agent keeps answering fluently, and it is now
wrong 8% of the time. Nothing throws. You find out from a customer.

Full rationale, architecture and build plan: [docs/spec.html](docs/spec.html).

## Quickstart

Requires Node 22.6+ (25 recommended — it runs TypeScript directly).

```bash
npm install
npm test          # 154 tests
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
| `fr replay <trace-id> [quality]` | Re-run a trace's input under a new config (`--mode live\|stubbed`) |
| `fr diff <baseline> <candidate>` | Naive side-by-side — **not** scoring |
| `fr freeze <trace-id>` | Promote a trace to a test case (`--suite`, `--drop`, `--tag`) |
| `fr cases [--suite name]` | List frozen cases |
| `fr check <case-id> <trace-id>` | Evaluate a case's assertions (tier 1 only) |
| `fr matrix` | Run every case × config × mode (`--models`, `--modes`, `--concurrency`) |
| `fr agents` | List registered agents |
| `fr seed` | Record every task in the set and freeze each as a case |
| `fr pool --set <name>` | Build blind judge-vs-human comparison pairs |
| `fr label --set <name>` | Label pairs blind — `1` / `2` / `t` / `s` / `q` |
| `fr calibrate --set <name>` | Measure the judge against those labels, write κ |
| `fr report` | Compare two configs with intervals → self-contained HTML |
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

## Stubbed vs live replay

When a case regresses the first question is always *did the model get worse, or
did the world change?* Running both modes answers it.

In **stubbed** mode the tools never execute — their responses are played back
from the recording, so the environment is held perfectly still and the only
thing that varies is the model and prompt. In **live** mode the tools run for
real, optionally inside a locked-down container.

```bash
npm run fr -- matrix --models qwen2.5:7b,llama3.2:3b --modes live,stubbed
```

```
  ok   qwen2.5:7b    stubbed  8962ms
  ok   qwen2.5:7b    live     9795ms
  ok   llama3.2:3b   live     5709ms
  ok   llama3.2:3b   stubbed  6076ms   stub: 0 exact, 1 loose, 0 miss, 1 unused

  qwen2.5:7b  live 6/6 · stubbed 6/6      llama3.2:3b  live 4/6 · stubbed 5/6
```

llama fails in *both* modes, so the environment is not the problem — the model
is. Its stub line says how: one tool called with different arguments than the
baseline, one recorded call never made at all.

Re-running the same matrix resumes every finished cell, so an interrupted run
costs seconds rather than starting over.

## Scoring, and why the judge is not trusted by default

Three tiers, cheapest first:

1. **Deterministic assertions.** A hard failure ends it — the judge is never
   called, which is what keeps judging a small fraction of a run rather than a
   second pass over everything.
2. **A pairwise judge.** "Is B worse than A" is far more stable than scoring one
   answer out of ten, and it is the question a regression report actually asks.
   Which answer is shown first is fixed by a hash of the item id: unbiased
   across the set, identical on every re-run.
3. **Calibration against human labels.** The judge runs over pairs a person has
   labelled blind, and the result is Cohen's κ — agreement corrected for luck.

That third tier is the point. Raw agreement is a flattering and mostly
meaningless number: if 70% of pairs are ties and the judge always says "tie", it
agrees 70% of the time while knowing nothing. κ scores that at zero, and there
is a test asserting exactly that.

**An uncalibrated judge is untrusted, not assumed good.** Below κ = 0.6 the
report marks judged verdicts untrusted rather than presenting them as fact.
Deterministic verdicts carry no such caveat — an assertion either held or it
did not.

```bash
npm run fr -- pool  --set metrics     # build blind comparison pairs
npm run fr -- label --set metrics     # a person labels them
npm run fr -- calibrate --set metrics # measure the judge, write κ
```

Labels live in `flightrecorder/labels/`, committed. They are the most expensive
data here and the only part nobody can generate — if a model labels the
calibration set, the judge has been graded by a model, which is the exact
failure this tier exists to detect.

## The report

```bash
npm run fr -- report --suite metrics \
  --baseline qwen2.5:7b --candidate llama3.2:3b --out report.html
```

```
Pass rate fell 95.5% (-100.0% to -86.4%, 95% CI, n=22).

  pass rate    100.0% → 4.5%
  cost/task    $0.000000 → $0.000000
  latency p95  10642ms → 21676ms
  21 regressions
```

Three things it will not do:

**It will not name a direction it cannot support.** Two flipped cases out of
forty produces *"No detectable change in pass rate: +5.0% (−2.5% to +12.5%),
not significant at n=40"* — and the test for that phase asserts the headline
contains neither "rose" nor "fell". Raise it to thirty flips and it does say
"rose"; the refusal is calibrated, not blanket.

**It will not report cost without quality.** Both sit in one table with their
intervals, because this project's own evidence is that resource metrics prefer
the broken agent.

**It will not present an uncalibrated judgement as fact.** Judged verdicts below
κ = 0.6 are marked untrusted, in the HTML, with a banner saying why.

The step diff explains regressions without anyone opening a trace:

> The runs diverge immediately: the baseline asked for search, the candidate
> asked for calculate.

That is llama3.2:3b's whole failure mode, stated automatically, across 20 of 25
diffs. Output is one self-contained HTML file — no script tag, no external
reference, attachable to a pull request.

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
