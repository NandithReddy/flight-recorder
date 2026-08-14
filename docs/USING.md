# Using this on your own agent

Everything below was run end to end against an agent that lives outside this
repository, on local models, with no API key. Nothing here is a sketch.

The whole adoption path is: **wrap your agent once, record real runs, freeze the
good ones, then run the frozen set against every change.**

---

## What problem this actually solves

You change a prompt, bump a model, or swap a tool. Your tests still pass, because
your tests check that the code runs — not that the answers are still right. The
agent keeps replying fluently and is now wrong more often than it was. Nothing
throws, so you find out from a user.

This catches that, and it catches it *before* the merge. The concrete daily
questions it answers:

| Question you actually have | What you run |
|---|---|
| "Is this prompt edit safe to merge?" | `fr gate --baseline "qwen2.5:7b#v1" --candidate "qwen2.5:7b#v2"` |
| "Can I move to the cheaper/smaller model?" | `fr matrix --models big,small` then `fr report` |
| "Did the agent get worse, or did our API change?" | `fr matrix --modes live,stubbed` |
| "Which step went wrong on that bad run?" | `fr show <trace-id>` |
| "How much does a run cost, and where?" | `fr stats`, `fr price` |
| "Is my LLM judge trustworthy at all?" | `fr calibrate --set <name>` |

---

## 1. Wrap your agent (about thirty lines, once)

An agent becomes recordable by exposing a `run` method that takes a context
instead of reaching for a model client itself. That single indirection is what
lets the harness put a span around every model and tool call, replay a run under
a different model, and stub the tools out.

```ts
// ~/work/my-app/flightrecorder/support-agent.ts
import { registerAgent } from "/path/to/flight-recorder/src/replay/registry.ts";
import type { RecordableAgent } from "/path/to/flight-recorder/src/replay/replay.ts";

export const supportAgent: RecordableAgent<string, string> = {
  ref: { name: "support-triage", version: "1.0.0" },

  async run(input, ctx) {
    // Wrap each tool once. The wrapper records the call and, in stubbed mode,
    // answers it from the recording instead of running it.
    const lookup = ctx.recorder.wrapTool("lookup_ticket", async (args: { id: string }) =>
      db.tickets.find(args.id),
    );

    const facts = await lookup({ id: "T-1041" });

    // Take the model, temperature and prompt version from the context, never
    // from a constant. Anything hardcoded here is an axis the matrix cannot
    // vary — this project shipped that bug three times (DECISIONS D-043).
    const reply = await ctx.client.generate({
      model: ctx.model,
      temperature: ctx.temperature,
      messages: [
        { role: "system", content: promptFor(ctx.promptVersion) },
        { role: "user", content: `${input}\n\nticket: ${facts}` },
      ],
    });

    return reply.text;
  },
};

registerAgent(supportAgent);
```

Point the CLI at that file with `FR_AGENTS` — a comma-separated list of modules
imported before any command runs:

```bash
export FR_AGENTS=~/work/my-app/flightrecorder/support-agent.ts
npm run fr -- agents
#   metrics-analyst@0.1.0     <- bundled examples
#   orchestrator@0.1.0
#   react-analyst@1.0.0
#   support-triage@1.0.0      <- yours
```

**Already using LangChain or LangGraph?** Skip the wrapper. `ModelClientChatBridge`
is a `BaseChatModel`, so hand it to your existing graph and it records
everything: see [examples/react-analyst.ts](../examples/react-analyst.ts), which
is LangGraph's prebuilt ReAct agent running on this harness in twenty lines.

## 2. Record real runs and freeze them into cases

Write the questions you actually care about to a JSON file — this is your test
suite, and it is the only part that needs thought:

```json
["Should ticket T-1041 be escalated today?",
 "What is the severity of ticket T-1041?",
 "Summarise ticket T-1041 for a standup."]
```

```bash
npm run fr -- seed --agent support-triage \
  --tasks ./tasks.json --suite support \
  --provider ollama --model qwen2.5:7b
```

```
recording 3 tasks on qwen2.5:7b  (agent support-triage)
  ok    1.  4 assertions  Should ticket T-1041 be escalated today?
  ok    2.  4 assertions  What is the severity of ticket T-1041?
  ok    3.  4 assertions  Summarise ticket T-1041 for a standup.

3 cases in suite "support"
```

The assertions are proposed by reading the recording, not written by hand — which
tool was called, which figures the answer used *that a tool actually produced*,
how many steps it took, what it cost. Read them in
`flightrecorder/suites/support.json`, delete any you disagree with, and commit
the file. **A suite is code: review it in a pull request like any other test.**

Prefer to curate one at a time? `fr record --input "..."` then
`fr freeze <trace-id>` does the same thing for a single run.

## 3. Run the suite whenever something changes

```bash
npm run fr -- matrix --suite support --models qwen2.5:7b,llama3.2:3b --modes live,stubbed
```

```
12 ran · 0 resumed · 0 could not run

tier-1 assertions  (not scoring — no judge, no statistics)
  qwen2.5:7b#v1 live        11/12   92%
  qwen2.5:7b#v1 stubbed     11/12   92%
  llama3.2:3b#v1 live       11/12   92%
  llama3.2:3b#v1 stubbed    11/12   92%
```

Read the two modes together, because they answer different questions:

- **live** runs your real tools — it tells you what a user would get today.
- **stubbed** replays tool responses from the recording, holding the world
  perfectly still — so a failure there is the *model or prompt*, never the
  environment.

A case that fails live and passes stubbed means your API changed, not your agent.
That distinction is normally an afternoon of guessing.

Finished cells are cached, so re-running after an interruption costs seconds
instead of re-doing the inference.

## 4. Make it block a bad merge

```bash
npm run fr -- gate --suite support --baseline qwen2.5:7b --candidate llama3.2:3b
```

```
PASS — qwen2.5:7b → llama3.2:3b, 3 cases, live mode
  ✓ pass-rate    +0.0%, not significant at n=3 — not blocking on noise
  ✓ p0-regression    no p0 case regressed
```

Note what it refused to do: with three cases it will not call a difference real.
The gate blocks on a *significant* drop — a confidence interval that excludes
zero — so it does not cry wolf on sampling noise, which is the reason people
switch these things off. Give it twenty or thirty cases before you trust it to
block anything.

In CI, commit your suite plus its baseline recordings and let a fresh clone run
them:

```bash
git add flightrecorder/ && git commit -m "Freeze the support suite"
npm run fr -- export --suite support     # now it can pin to that commit
git add flightrecorder/traces/ && git commit --amend --no-edit
```

Order matters: `export` refuses to pin a baseline while the working tree is
dirty, and `seed` has just written an untracked suite file. Pin against a commit
that exists, or the export records `commit: null` and nobody can tell later
which code produced those baselines.

```yaml
env:
  # Without this the matrix cannot resolve your agent and every cell fails.
  FR_AGENTS: ./flightrecorder/support-agent.ts
steps:
  - run: npm ci
  - run: npm run fr -- import --suite support
  - run: npm run fr -- matrix --suite support --provider ollama
        --models qwen2.5:7b --modes live --concurrency 4
  - run: npm run fr -- gate --suite support
        --baseline "qwen2.5:7b#v1" --candidate "qwen2.5:7b#v1"
        --baseline-committed --fail-on-any-regression --no-judge
```

Three things that bite here, all of which bit this repo first:

- **`FR_AGENTS` must be set in CI too.** The matrix resolves an agent by name
  from the registry, and a fresh clone has only the bundled examples in it.
- **Both `--baseline` and `--candidate` are required**, even when comparing a
  config against its own committed recordings. `--baseline-committed` says
  *where* the baseline comes from, not *what* it is.
- **`--provider mock` is not a shortcut for your agent.** This repo's mock is
  scripted to its own demo, so it returns demo answers whatever you ask it. Use
  a real provider, or write a mock for your agent.

[.github/workflows/flight-recorder.yml](../.github/workflows/flight-recorder.yml)
is this repo's own working version, including the job that proves the gate still
catches a known regression.

---

## What to expect in the first week

**Day one is worth it on its own.** Recording ten real runs and reading the
traces usually surfaces something: a tool called with the wrong arguments, a step
that never fires, a number in the answer that no tool ever produced. This project
found a 3B model inventing its inputs and computing correctly over them — right
arithmetic, fabricated figures — the first time it saw a real model.

**Three honest limits, so nothing surprises you:**

- **The LLM judge is not trustworthy yet** — κ = 0.209 against human labels here,
  below the 0.6 bar, so the system marks those verdicts untrusted and the gate
  refuses to block on them. Deterministic assertions do the blocking. Pass
  `--no-judge` and lose nothing that matters.
- **Small suites cannot detect small regressions.** Under ~20 cases the gate will
  correctly refuse to call anything significant.
- **The hosted-provider path has never made a live call.** The adapter is
  written and tested; this project ran entirely on local models by choice. If you
  use `--provider gateway`, you are the first.
