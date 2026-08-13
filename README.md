# Flight Recorder

An evaluation and regression harness for LLM agents. It records real agent
runs, freezes them into replayable test cases, and blocks any change that
quietly makes the agent worse.

> **Status: phase 0 of 8 — spike complete.** The end-to-end skeleton works:
> record → store → replay → naive diff. No scoring, no statistics, no CI gate
> yet. See [docs/PHASES.md](docs/PHASES.md).

## Why

Conventional software fails loudly. Agent software fails *quietly* — you change
a prompt or bump a model, the agent keeps answering fluently, and it is now
wrong 8% of the time. Nothing throws. You find out from a customer.

Full rationale, architecture and build plan: [docs/spec.html](docs/spec.html).

## Quickstart

Requires Node 22.6+ (25 recommended — it runs TypeScript directly).

```bash
npm install
npm test          # 12 tests
npm run typecheck
```

Record a run from the built-in demo agent, then replay it under a degraded
configuration:

```bash
npm run fr -- record
npm run fr -- ls
npm run fr -- replay <trace-id> degraded
```

No API key needed. Phases 0–3 run against a deterministic mock provider that
costs nothing.

## What the demo shows

The baseline agent verifies its arithmetic with a tool and answers `18.33%`.
The degraded one skips verification and answers `roughly 25%`. It does not
error. It does not throw. It reads as confident, fluent English — and it is
**33% cheaper and 33% faster**, so anything optimising on cost alone would
promote it.

That is the failure mode this project exists to catch.

## Commands

| Command | Does |
|---|---|
| `fr record [good\|degraded]` | Run the demo agent, store the trace |
| `fr ls [limit]` | List stored traces |
| `fr show <trace-id>` | Print one trace with its spans |
| `fr replay <trace-id> [quality]` | Re-run a trace's input under a new config |
| `fr diff <baseline> <candidate>` | Naive side-by-side — **not** scoring |
| `fr stats` | Store size and dedupe status |

## Layout

```
src/core/       the seven objects everything is built from
src/provider/   provider-agnostic ModelClient seam + mock client
src/recorder/   span capture, redaction, trace assembly
src/store/      content-addressed trace storage
src/replay/     record and replay entrypoints
examples/       demo agent used as the harness's test subject
docs/           spec, phase checklist, decision log
```

## Working on this

- [docs/PHASES.md](docs/PHASES.md) — what is done, what is next, exit criteria
- [docs/DECISIONS.md](docs/DECISIONS.md) — every design call and what would reverse it

Two decisions are still open and both are flagged in the decision log: which
model provider to adopt (needed before phase 4), and the 200 human labels the
judge calibration depends on.
