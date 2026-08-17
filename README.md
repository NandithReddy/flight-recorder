# Flight Recorder

An evaluation and regression harness for LLM agents. It records real agent
runs, freezes them into replayable test cases, and blocks any change that
quietly makes the agent worse.

> **Status: all seven build phases built; six meet their exit criteria.**
> Phase 4's bar — an LLM judge agreeing with humans at κ ≥ 0.6 — reached 0.687
> on the labels its prompt was written against, then **0.429 on 42 held-out
> pairs**, so it is published as *not met*. Eleven of the twelve held-out
> disagreements are one rule, worth half a κ. Record → freeze → matrix →
> score → report → gate, now proven against an agent this project did not
> write: LangGraph's prebuilt ReAct loop runs on the harness through a
> ~150-line bridge, with recording, stubbed replay and the gate applying
> unchanged. See [docs/PHASES.md](docs/PHASES.md).

## Why

Conventional software fails loudly. Agent software fails *quietly* — you change
a prompt or bump a model, the agent keeps answering fluently, and it is now
wrong 8% of the time. Nothing throws. You find out from a customer.

Full rationale, architecture and build plan: [docs/spec.html](docs/spec.html).

**Using it on your own agent: [docs/USING.md](docs/USING.md)** — wrap your agent
in about thirty lines, seed a suite from your own questions, gate it in CI.

The postmortem — every defect with its evidence, and the numbers that had to be
corrected twice — is [docs/writeup.html](docs/writeup.html).

**It caught fourteen defects, and none of them crashed.** Every one was a number
that was quietly wrong — including one in this repository's own judge, which
measured *worse than chance* against human labels; one the gate caught in a
commit of mine that a full green test suite had waved through; and one that sat
unreachable for four phases until a foreign agent's different error semantics
exposed it. The decision log ([docs/DECISIONS.md](docs/DECISIONS.md)) records
each with its evidence.

A worked example is [PR #2](https://github.com/NandithReddy/flight-recorder/pull/2):
an innocuous-looking prompt cleanup where all 174 tests pass, typecheck is
clean, and the gate blocks it anyway.

## Quickstart

Requires **Node 24+** — it runs TypeScript directly and uses the built-in
`node:sqlite`, both of which are flag-gated on earlier releases. CI runs Node 24;
development was on 25.

```bash
npm install
npm test          # 203 tests
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
**59% cheaper and 32% faster** ($0.001902 → $0.000774), so anything optimising
on cost alone would promote it.

Freezing the good run proposes nine assertions with no hand-authoring, because
`18.33` appears in both the calculator's output and the final answer — which
makes it a checked fact rather than a claim. Checking that case against the
degraded run gives:

```
pass  no_error(1)                    no error
pass  tool_called(search)            called: search
FAIL  tool_called(calculate)         called: search
FAIL  output_contains(18.33)         "18.33" absent from the output
FAIL  output_contains(1,200,000)     "1,200,000" absent from the output
FAIL  output_contains(1,420,000)     "1,420,000" absent from the output
pass  max_steps(7)                   3 steps (limit 7)
pass  max_cost_usd(0.00285)          $0.000774 (limit $0.002850)
pass  max_wall_ms(60)                13ms (limit 60ms)

5/9 assertions passed  ·  4 hard failures
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
| `fr record [good\|degraded]` | Run an agent (`--agent`, `--input`, `--provider mock\|ollama\|gateway`, `--model`) |
| `fr ls [limit]` | List stored traces |
| `fr show <trace-id>` | Print one trace with its spans |
| `fr replay <trace-id> [quality]` | Re-run a trace's input under a new config (`--mode live\|stubbed`) |
| `fr diff <baseline> <candidate>` | Naive side-by-side — **not** scoring |
| `fr freeze <trace-id>` | Promote a trace to a test case (`--suite`, `--drop`, `--tag`) |
| `fr cases [--suite name]` | List frozen cases |
| `fr check <case-id> <trace-id>` | Evaluate a case's assertions (tier 1 only) |
| `fr matrix` | Run every case × config × mode (`--models`, `--modes`, `--concurrency`) |
| `fr agents` | List registered agents (add your own with `FR_AGENTS=./agent.ts`) |
| `fr seed` | Record every task and freeze each as a case (`--tasks <file.json>`, `--agent`) |
| `fr pool --set <name>` | Build blind judge-vs-human comparison pairs |
| `fr label --set <name>` | Label pairs blind — `1` / `2` / `t` / `s` / `q` |
| `fr calibrate --set <name>` | Measure the judge against those labels, write κ |
| `fr report` | Compare two configs with intervals → self-contained HTML |
| `fr gate` | Same comparison, as a merge decision (exit 0 or 1) |
| `fr export` / `fr import` | Make a suite runnable on another machine |
| `fr doctor` | Can this suite run here? |
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

tier-1 assertions  (not scoring — no judge, no statistics)
  qwen2.5:7b#v1 live         6/6   100%
  qwen2.5:7b#v1 stubbed      6/6   100%
  llama3.2:3b#v1 live        4/6    67%
  llama3.2:3b#v1 stubbed     5/6    83%
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

This judge spent most of the project below that line, at κ = 0.209, and one
version of it scored **−0.102 — significantly worse than chance**. What moved it
to **0.687** was two changes that only work together:

| judge prompt | rubric | κ |
|---|---|---|
| v1 — "correct, complete and supported by the work shown" | blind | −0.102 |
| v2 — written against v1's confusion matrix | blind | 0.209 |
| v3 — a procedure: extract both figures, tie if they match | blind | 0.459 |
| v3 | answer key | 0.188 |
| **v4 — v3, with the rubric fenced off from the tie test** | **answer key** | **0.687** |
| v4 on **42 held-out pairs it was never tuned against** | answer key | **0.429** |

The judge had been graded blind against humans who labelled with the answer key
open — an information gap, not a judging failure. But handing that key to v3
*halved* its score: given a reference, the model grades resemblance to it and
stops calling equal answers equal. One paragraph fencing the rubric out of the
tie test took it from 0.188 to 0.687.

**Then held-out validation took it back to 0.429**, and the way it fell is the
useful part. Eleven of the twelve disagreements are one shape: a candidate
answer giving the *correct figure* on top of *invented numbers* — "grew by
40.00%, from 9,000 to 12,345", where the key says 145 → 203. The human called
those ties. The judge called the clean answer better. Align that single rule and
the same verdicts score **κ = 0.937**.

So the tier's limit is not the model or the prompt: **κ measures agreement, not
correctness, and a judge stricter than its labeller is punished for it.**
Re-labelling those eleven pairs would clear the bar and mean nothing — it is
grading to the test, which is the exact failure this tier exists to detect.
[D-048](docs/DECISIONS.md) and [D-049](docs/DECISIONS.md) carry the confusion
matrices.

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

## The gate

```bash
npm run fr -- gate --suite metrics \
  --baseline "qwen2.5:7b#v1" --candidate "qwen2.5:7b#v0" --critical-tag p0
```

```
FAIL — qwen2.5:7b → qwen2.5:7b, 30 cases, live mode
  ✗ pass-rate            -20.0% (-36.7% to -6.7%)
  ✓ p0-regression        no p0 case regressed
exit code: 1
```

It blocks on **significance, not direction**. One regression in forty is real
but is not evidence, and the gate says *"not blocking on noise"* rather than
failing — because a gate people override by habit protects nothing. Two
exceptions: a `p0`-tagged regression fails on its own, and
`--fail-on-any-regression` exists for suites large enough that any regression is
signal.

**Untrusted verdicts never block a build.** A judge not calibrated well enough
to be presented as fact is not calibrated well enough to fail someone's merge.

### Portability

A committed suite points at traces in a local, gitignored database — so on a
fresh clone it would fail with "trace not in the store". Export fixes that:

```bash
npm run fr -- export --suite metrics   # traces → git, baseline pinned to HEAD
npm run fr -- import --suite metrics   # on any other machine
npm run fr -- doctor --suite metrics   # can this suite run here?
```

CI runs `import` then `doctor` on every push, so the claim is tested rather than
assumed. Pinning **refuses on a dirty tree** — a baseline pinned to a commit that
does not describe the working tree looks reproducible without being so.

## An agent this project did not write

The loop under test in phase 7 is LangGraph's prebuilt ReAct agent. Its model
calls reach the harness through a `BaseChatModel` bridge
([src/provider/langchain-bridge.ts](src/provider/langchain-bridge.ts)), so
recording, stubbed replay, freezing and the gate all apply to it unchanged —
registering it was one line.

```bash
npm run fr -- record --agent react-analyst --provider ollama --model qwen2.5:7b
npm run fr -- matrix --suite react --models qwen2.5:7b,llama3.2:3b --modes live,stubbed
```

Same 30 tasks, same tools, same prompts, same temperature — only the loop
differs. Both loops are scored against one assertion set, since each suite's own
assertions are a different ruler (`node scripts/loop-compare.ts`):

| live runs | hand-rolled | LangGraph ReAct |
|---|---|---|
| llama3.2:3b hard assertions | 60% | **71%** |
| llama3.2:3b runs that died | 13 of 30 | **0 of 30** |
| qwen2.5:7b hard assertions | 97% | 97% |
| qwen2.5:7b cases passed | 27/30 | 27/30 |

The weak model gains eleven points and stops dying; the strong model cannot tell
the two loops apart. Both emit the *same* 13 failed tool calls — the mistakes
belong to the model — but LangGraph hands each error back for a retry where our
loop aborts. **So the loop is not a quality parameter in general, it is a
recovery parameter**, worth exactly as much as the model errs, and a harness
that only ever tested one loop would never see either half of that.

Integrating the foreign agent also exposed a defect that had been unreachable
for four phases: stubbed replay served a recorded tool *failure* as a
successful `null`, because only an agent that recovers from tool errors can
produce a clean baseline containing an errored span. Fixed, pinned, and
recorded as [D-042](docs/DECISIONS.md).

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
