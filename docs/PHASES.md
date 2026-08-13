# Build phases

Exit criteria are things someone else can check, not feelings of doneness.
Full rationale for each phase lives in [spec.html](./spec.html).

| # | Phase | Days | Status |
|---|-------|------|--------|
| 00 | Spike | 1–2 | **done** |
| 01 | Recorder | 3–5 | **done** |
| 02 | Store + freezer | 2–3 | **done** |
| 03 | Replayer | 4–6 | **done** |
| 04 | Scorer | 5–7 | **built — awaiting labels** |
| 05 | Reporter | 3–4 | **done** |
| 06 | Gate | 2 | next |
| 07 | Dogfood + writeup | 4–5 | |

---

## Phase 00 — Spike — **done**

**Exit criterion:** end-to-end skeleton exists. No scoring yet.

- [x] All seven core objects defined (`src/core/types.ts`)
- [x] Provider-agnostic `ModelClient` seam (`src/provider/types.ts`)
- [x] Recorder capturing model and tool spans with usage and wall time
- [x] Content-addressed trace store with working dedupe
- [x] Replay of a stored trace's input under a different config
- [x] CLI: `record`, `ls`, `show`, `replay`, `diff`, `stats`
- [x] 12 tests passing, `tsc --noEmit` clean

**Evidence.** `npm run fr -- record` then `npm run fr -- replay <id> degraded`
produces the regression this project exists to catch: the degraded run skips
the `calculate` verification step, answers `roughly 25%` instead of `18.33%`,
throws nothing, errors nothing, and reads as fluent English. It is also
**33% cheaper and faster** — a naive cost optimiser would promote it.

---

## Phase 01 — Recorder — **done**

**Exit criterion:** a real agent run produces a complete, replayable trace.

- [x] OpenTelemetry GenAI semantic conventions (`src/otel/conventions.ts`)
- [x] `Recorder` surface preserved — all 12 phase-0 tests pass unchanged
- [x] Real provider adapter: AI SDK via the Vercel AI Gateway (DECISIONS D-012)
- [x] Redaction ruleset with tests, applied on the way in
- [x] Sampling wired into `record()`; errors and flagged runs always kept
- [x] Span nesting verified against a genuinely nested agent
- [x] Cost table with cache multipliers and promotional pricing
- [x] 40 tests passing, `tsc --noEmit` clean

**Evidence.** `fr price` resolves Sonnet 5 to its promotional $2/$10 today and
to $3/$15 on 2026-09-01. The nested-agent test asserts a sub-agent's spans
parent to the delegating span while two concurrent tool calls both parent to the
root — the case a stack-based recorder gets wrong intermittently.

**What phase 01 caught in its own instrumentation.** A failing span count
revealed that `AgentContext.client` arrives already wrapped, so an agent
re-wrapping it recorded two spans per model call and doubled every token and
cost total — no error, no symptom, just wrong numbers. Fixed in the API rather
than the test (DECISIONS D-011). Keep this for the phase 07 writeup.

**Live-provider verification is still outstanding.** The gateway adapter is
tested for credential handling, message conversion, and cost mapping, but has
not made a real API call — no key is configured yet. First task of phase 02:
export `AI_GATEWAY_API_KEY` and record one real trace.

## Phase 02 — Store + freezer — **done**

**Exit criterion:** ten cases created from real traces in under twenty minutes.

- [x] SQLite index behind the existing `TraceStore` interface — `node:sqlite`,
      not `better-sqlite3` (DECISIONS D-015)
- [x] Payload-level dedupe, extracted bottom-up (D-016)
- [x] `fr freeze <trace-id>` promoting a trace to a `TestCase`
- [x] Assertions proposed automatically, each with a rationale
- [x] Suite file format, committed and diffable (D-017)
- [x] 67 tests passing, `tsc --noEmit` clean

**Evidence.** Ten traces recorded and frozen in **4.7 seconds** of machine time,
producing 9 assertions each with no hand-authoring. Dedupe: 60 references to 5
unique payloads, 43% smaller than storing them inline. A committed example suite
is at `flightrecorder/suites/example.json` (82 lines, readable).

**The whole phase in one result.** Freeze a case from a good run, then check it
against the degraded replay:

```
FAIL  tool_called(calculate)        called: search
FAIL  output_contains(18.33)        "18.33" absent from the output
pass  max_steps(7)                  3 steps (limit 7)
pass  max_cost_usd(0.00173)         $0.000774 (limit $0.001730)
pass  max_wall_ms(54)               13ms (limit 54ms)
```

Every resource assertion passes, because the broken agent is cheaper and faster
than the correct one. Only the semantic assertions catch it — and nobody wrote
them.

**Deferred:** interactive per-assertion editing at freeze time. `--drop` covers
the common case and keeps the command scriptable; a TUI can come later if the
dogfooding in phase 07 shows it is needed.

## Phase 03 — Replayer — **done**

**Exit criterion:** fifty cases × three configs runs unattended to completion.

- [x] Matrix runner with a concurrency cap
- [x] Backoff on transient failures, resumability after interruption
- [x] `stubbed` mode: tool responses played back from the recorded trace
- [x] `live` mode, with an optional Docker sandbox for tools that shell out
- [x] Agent registry so a case resolves back to code
- [x] Stubbed-vs-live demonstrated as diagnostic
- [x] 97 tests passing, `tsc --noEmit` clean

**Evidence.** One frozen case across two local models and both modes:

```
  ok   qwen2.5:7b    stubbed  8962ms
  ok   qwen2.5:7b    live     9795ms
  ok   llama3.2:3b   live     5709ms
  ok   llama3.2:3b   stubbed  6076ms   stub: 0 exact, 1 loose, 0 miss, 1 unused

tier-1 assertions
  qwen2.5:7b  live       6/6   100%
  qwen2.5:7b  stubbed    6/6   100%
  llama3.2:3b live       4/6    67%
  llama3.2:3b stubbed    5/6    83%
```

Read the two together and the diagnosis is unambiguous: llama fails in *both*
modes, so the environment is not the problem — the model is. Its stub line says
how: one tool called with different arguments than the baseline, one recorded
call never made at all.

Re-running resumed all four cells in **0.38s** instead of ~30s of inference.

**Sandbox scope, stated rather than quietly skipped.** The Docker sandbox is
built and tested against real containers — network denied, read-only root,
dropped capabilities, timeout enforced. It is opt-in per tool, because the demo
agent's tools are pure in-process functions and containerising one would be
theatre. It exists for the shape phase 07's open-source agent is likely to have.

## Phase 04 — Scorer — **machinery built, calibration awaiting labels**

**Exit criterion:** κ ≥ 0.6 on 200 labelled examples; judging under 15% of run cost.

- [x] Tier 1 deterministic assertions, with early exit on hard failure
- [x] Tier 2 pairwise judge, presentation order fixed by hash against position bias
- [x] Tier 3 calibration harness over the human-labelled set
- [x] Cohen's κ with a bootstrap interval, attached to every judged verdict as `trust`
- [x] Verdicts degrade honestly — an uncalibrated judge is untrusted by default
- [x] Blind labelling CLI, incremental save, committed label store
- [x] 137 tests passing, `tsc --noEmit` clean
- [ ] **The labels themselves — Nandith's task, not delegable**

**Why the last box cannot be ticked by the harness.** If the calibration set is
labelled by a model, the judge has been graded by a model, which is precisely
the failure tier 3 exists to detect. The labels have to come from a person.

**What is ready.** `fr pool` builds blind comparison pairs from stored matrix
attempts; `fr label` presents them one at a time and saves after every keypress;
`fr calibrate` runs the judge across them and writes κ, its interval, the
confusion matrix, the unreadable-reply rate and optionally the position-flip
rate to a committed file the report can cite.

**A flaky test, found and fixed.** One phase-4 test passed or failed depending on
a random trace id, because it used the same trace as both baseline and candidate
and the judge's A/B slot is derived from that id. A non-deterministic test in a
project arguing for trustworthy measurement is the wrong kind of irony. Rewritten
to assert what its name claims; five consecutive clean runs.

## Phase 05 — Reporter — **done**

**Exit criterion:** the report refuses to call a two-case delta significant at n=40.

- [x] Percentile bootstrap over 10k resamples; cases resampled as pairs (D-031)
- [x] Pass-rate, cost-per-task and p95 latency deltas, each with an interval
- [x] Per-case regression list, with newly-passing cases counted separately
- [x] Step diff naming the exact diverging decision (D-034)
- [x] Self-contained static HTML — no script, no external reference of any kind
- [x] 154 tests passing, `tsc --noEmit` clean

**Evidence — the exit criterion is a test.** A suite of 40 cases where 2 flip
from fail to pass produces `+5.0%`, and the report says:

> No detectable change in pass rate: +5.0% (−2.5% to +12.5%), not significant at n=40.

The test also asserts the headline contains neither "rose" nor "fell". Raise the
flips to 30 of 40 and it does say "rose" — the refusal is calibrated, not blanket.

**Evidence — on live data.** qwen2.5:7b vs llama3.2:3b over 22 real cases:

```
Pass rate fell 95.5% (-100.0% to -86.4%, 95% CI, n=22).
  pass rate    100.0% → 4.5%
  latency p95  10642ms → 21676ms
  21 regressions
```

And the step diff explains why, without anyone reading a trace:

> The runs diverge immediately: the baseline asked for search, the candidate
> asked for calculate.

That single sentence covers 20 of 25 diffs and is llama's whole failure mode.

**A flaw found by running it on real data.** The first diff compared span names,
so on a cross-model report every step "differed" — the model *is* the change.
Rewritten to compare decisions rather than identities (D-034).

## Phase 06 — Gate

**Exit criterion:** a deliberately worsened prompt fails CI on a real pull request.

- [ ] CLI exit codes on: significant pass-rate drop, any `p0` case regressing,
      cost per task over ceiling, p95 latency over ceiling
- [ ] Baselines pinned by commit
- [ ] GitHub Action wrapping the CLI
- [ ] Demonstrated on a real PR in the public repo

## Phase 07 — Dogfood + writeup

**Exit criterion:** a public report showing a regression the harness caught first.

- [ ] Point the harness at the chosen open-source agent
- [ ] Build a real suite from real traces
- [ ] Run the full matrix, publish the report
- [ ] Writeup: what was measured, what surprised you, what you got wrong
- [ ] Verify: `npm i` to first report in under twenty minutes on a clean machine
