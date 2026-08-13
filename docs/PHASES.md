# Build phases

Exit criteria are things someone else can check, not feelings of doneness.
Full rationale for each phase lives in [spec.html](./spec.html).

| # | Phase | Days | Status |
|---|-------|------|--------|
| 00 | Spike | 1–2 | **done** |
| 01 | Recorder | 3–5 | next |
| 02 | Store + freezer | 2–3 | |
| 03 | Replayer | 4–6 | |
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

## Phase 01 — Recorder — next

**Exit criterion:** a real agent run produces a complete, replayable trace.

- [ ] Replace hand-rolled spans with OpenTelemetry GenAI semantic conventions
- [ ] Keep the current `Recorder` surface so nothing downstream changes
- [ ] Real provider adapter (decision pending — see DECISIONS D-002)
- [ ] Redaction ruleset with tests, applied on the way in
- [ ] Sampling: configurable rate, but always keep errored and flagged runs
- [ ] Span nesting verified against a genuinely nested agent
- [ ] Cost table per provider, replacing the mock's synthetic prices

## Phase 02 — Store + freezer

**Exit criterion:** ten cases created from real traces in under twenty minutes.

- [ ] SQLite index (`better-sqlite3`) behind the existing `TraceStore` interface
- [ ] Payload-level dedupe — system prompts repeat thousands of times
- [ ] `fr freeze <trace-id>` promoting a trace to a `TestCase`
- [ ] **Assertions proposed automatically** by reading the trace, then edited
- [ ] Suite file format, human-readable and diffable in git
- [ ] Timed run: authoring one case takes under ninety seconds

## Phase 03 — Replayer

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
