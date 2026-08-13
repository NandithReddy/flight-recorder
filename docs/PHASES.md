# Build phases

Exit criteria are things someone else can check, not feelings of doneness.
Full rationale for each phase lives in [spec.html](./spec.html).

| # | Phase | Days | Status |
|---|-------|------|--------|
| 00 | Spike | 1–2 | **done** |
| 01 | Recorder | 3–5 | **done** |
| 02 | Store + freezer | 2–3 | **done** |
| 03 | Replayer | 4–6 | next |
| 04 | Scorer | 5–7 | |
| 05 | Reporter | 3–4 | |
| 06 | Gate | 2 | |
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

## Phase 03 — Replayer — next

**Exit criterion:** fifty cases × three configs runs unattended to completion.

- [ ] Matrix runner with a concurrency cap
- [ ] Rate-limit backoff and resumability after interruption
- [ ] `stubbed` mode: tool responses played back from the recorded trace
- [ ] `live` mode: tools execute for real inside Docker
- [ ] Agent registry so the CLI resolves entrypoints by name
- [ ] Stubbed-vs-live difference demonstrated as diagnostic on one real case

## Phase 04 — Scorer

**Exit criterion:** κ ≥ 0.6 on 200 labelled examples; judging under 15% of run cost.

- [ ] Tier 1 deterministic assertions, with early exit on hard failure
- [ ] Tier 2 pairwise judge, candidate order randomised against position bias
- [ ] Tier 3 calibration harness over a held-out human-labelled set
- [ ] Cohen's κ computed and attached to every verdict as `trust`
- [ ] Report degrades honestly when κ is low
- [ ] **Blocked on 200 human labels — Nandith's task, not delegable**

## Phase 05 — Reporter

**Exit criterion:** the report refuses to call a two-case delta significant at n=40.

- [ ] Bootstrap resampling (~10k iterations), no t-tests on binary outcomes
- [ ] Pass-rate delta with interval, plus cost and p95 latency deltas
- [ ] Per-case regression list
- [ ] Side-by-side trace diff showing the exact diverging step
- [ ] Self-contained static HTML output

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
