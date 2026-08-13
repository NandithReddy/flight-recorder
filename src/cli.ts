#!/usr/bin/env node
/**
 * fr — the Flight Recorder CLI.
 *
 * Phase 0 surface: record, ls, show, replay, diff, stats. `diff` here is a
 * naive side-by-side print, NOT scoring — the three-tier scorer lands in
 * phase 4 and the statistical report in phase 5.
 */

import { makeConfig } from "./core/ids.ts";
import { FsTraceStore } from "./store/fs-store.ts";
import { record, replay } from "./replay/replay.ts";
import { createMockClient, type MockQuality } from "./provider/mock.ts";
import { DEMO_QUESTION, demoAgent } from "../examples/demo-agent.ts";
import type { Trace } from "./core/types.ts";

const store = new FsTraceStore();

function configFor(quality: MockQuality) {
  return makeConfig({
    provider: "mock",
    model: "demo-model",
    promptVersion: quality === "good" ? "v1" : "v2-degraded",
    toolset: ["search", "calculate"],
    temperature: 0,
  });
}

const usd = (n: number) => `$${n.toFixed(6)}`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function printTrace(trace: Trace): void {
  console.log(bold(trace.id));
  console.log(`  agent   ${trace.agent.name}@${trace.agent.version}`);
  console.log(`  config  ${trace.config.id}  ${dim(trace.config.promptVersion)}`);
  console.log(`  input   ${JSON.stringify(trace.input)}`);
  console.log(`  output  ${JSON.stringify(trace.output)}`);
  console.log(
    `  totals  ${trace.totals.steps} spans · ${trace.totals.wallMs}ms · ` +
      `${trace.totals.inputTokens}+${trace.totals.outputTokens} tok · ${usd(trace.totals.costUsd)}`,
  );
  console.log(dim("  spans"));
  for (const span of trace.spans) {
    const detail =
      span.kind === "tool"
        ? JSON.stringify(span.output).slice(0, 60)
        : `${span.usage?.outputTokens ?? 0} out-tok`;
    console.log(
      dim(`    ${span.kind.padEnd(5)} ${span.name.padEnd(14)} ${String(span.endedAt - span.startedAt).padStart(5)}ms  ${detail}`),
    );
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "record": {
      const quality = (rest[0] ?? "good") as MockQuality;
      const trace = await record({
        agent: demoAgent,
        client: createMockClient({ quality }),
        config: configFor(quality),
        input: DEMO_QUESTION,
        store,
        tags: [quality],
      });
      printTrace(trace);
      return 0;
    }

    case "ls": {
      const entries = await store.list({ limit: Number(rest[0] ?? 20) });
      if (entries.length === 0) {
        console.log(dim("No traces yet. Run: npm run fr -- record"));
        return 0;
      }
      for (const entry of entries) {
        const when = new Date(entry.startedAt).toISOString().slice(11, 19);
        console.log(
          `${entry.id}  ${when}  ${entry.agent.name.padEnd(16)} ` +
            `${entry.configId}  ${String(entry.totals.steps).padStart(2)} spans  ` +
            `${usd(entry.totals.costUsd)}  ${entry.ok ? "ok" : "ERR"}` +
            (entry.replayOf ? dim(`  replay-of ${entry.replayOf}`) : ""),
        );
      }
      return 0;
    }

    case "show": {
      const id = rest[0];
      if (!id) throw new Error("usage: fr show <trace-id>");
      const trace = await store.get(id);
      if (!trace) throw new Error(`No trace with id ${id}`);
      printTrace(trace);
      return 0;
    }

    case "replay": {
      const id = rest[0];
      if (!id) throw new Error("usage: fr replay <trace-id> [good|degraded]");
      const quality = (rest[1] ?? "degraded") as MockQuality;
      const { baseline, candidate } = await replay({
        traceId: id,
        agent: demoAgent,
        client: createMockClient({ quality }),
        config: configFor(quality),
        store,
      });
      console.log(bold("baseline"));
      printTrace(baseline);
      console.log();
      console.log(bold("candidate"));
      printTrace(candidate);
      console.log();
      printNaiveDiff(baseline, candidate);
      return 0;
    }

    case "diff": {
      const [a, b] = rest;
      if (!a || !b) throw new Error("usage: fr diff <baseline-id> <candidate-id>");
      const baseline = await store.get(a);
      const candidate = await store.get(b);
      if (!baseline) throw new Error(`No trace with id ${a}`);
      if (!candidate) throw new Error(`No trace with id ${b}`);
      printNaiveDiff(baseline, candidate);
      return 0;
    }

    case "stats": {
      const s = await store.stats();
      console.log(`traces ${s.traces} · blobs ${s.blobs} · ${(s.bytes / 1024).toFixed(1)} KiB`);
      console.log(dim(`root   ${store.root}`));
      return 0;
    }

    default:
      console.log(`fr — Flight Recorder (phase 0)

  record [good|degraded]        run the demo agent and store the trace
  ls [limit]                    list stored traces
  show <trace-id>               print one trace with its spans
  replay <trace-id> [quality]   re-run a trace's input under a new config
  diff <baseline> <candidate>   naive side-by-side (NOT scoring)
  stats                         store size and dedupe status
`);
      return command ? 1 : 0;
  }
}

function printNaiveDiff(baseline: Trace, candidate: Trace): void {
  const sameOutput = JSON.stringify(baseline.output) === JSON.stringify(candidate.output);
  const toolNames = (t: Trace) =>
    t.spans.filter((s) => s.kind === "tool").map((s) => s.name);

  console.log(bold("naive diff") + dim("  (phase 0 — no scoring, no statistics)"));
  console.log(`  output identical   ${sameOutput ? "yes" : "NO"}`);
  console.log(`  steps              ${baseline.totals.steps} -> ${candidate.totals.steps}`);
  console.log(`  tools called       [${toolNames(baseline).join(", ")}] -> [${toolNames(candidate).join(", ")}]`);
  console.log(`  cost               ${usd(baseline.totals.costUsd)} -> ${usd(candidate.totals.costUsd)}`);
  console.log(`  wall              ${String(baseline.totals.wallMs).padStart(5)}ms -> ${candidate.totals.wallMs}ms`);
  if (!sameOutput) {
    console.log();
    console.log(dim(`  baseline  ${JSON.stringify(baseline.output)}`));
    console.log(dim(`  candidate ${JSON.stringify(candidate.output)}`));
  }
}

const code = await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
  return 1;
});
process.exit(code);
