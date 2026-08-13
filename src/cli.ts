#!/usr/bin/env node
/**
 * fr — the Flight Recorder CLI.
 *
 * Phase 0 surface: record, ls, show, replay, diff, stats. `diff` here is a
 * naive side-by-side print, NOT scoring — the three-tier scorer lands in
 * phase 4 and the statistical report in phase 5.
 */

import { makeConfig } from "./core/ids.ts";
import { SqliteTraceStore } from "./store/sqlite-store.ts";
import { record, replay } from "./replay/replay.ts";
import { createMockClient, type MockQuality } from "./provider/mock.ts";
import { createGatewayClient } from "./provider/ai-gateway.ts";
import {
  createOllamaClient,
  DEFAULT_OLLAMA_HOST,
  isOllamaRunning,
  listOllamaModels,
  OllamaUnavailableError,
} from "./provider/ollama.ts";
import { CACHE_MULTIPLIERS, PRICES, priceFor } from "./provider/pricing.ts";
import { analyzeOutput, evaluateAll } from "./freeze/assertions.ts";
import { freeze } from "./freeze/freezer.ts";
import { SuiteStore } from "./freeze/suite.ts";
import { DEMO_QUESTION, demoAgent } from "../examples/demo-agent.ts";
import { runMatrix } from "./replay/matrix.ts";
import { listAgents } from "./replay/registry.ts";
import "../examples/register.ts";
import type { ReplayMode, Trace } from "./core/types.ts";

const store = new SqliteTraceStore();
const suites = new SuiteStore();

/** Minimal flag parsing: `--name value` and `--name`. */
function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, "true");
    }
  }
  return { positional, flags };
}

const DEFAULT_LOCAL_MODEL = "llama3.2:3b";

interface Target {
  provider: string;
  model: string;
  quality: MockQuality;
}

function targetFrom(flags: Map<string, string>, quality: MockQuality): Target {
  const provider = flags.get("provider") ?? "mock";
  const model =
    flags.get("model") ?? (provider === "ollama" ? DEFAULT_LOCAL_MODEL : "demo-model");
  return { provider, model, quality };
}

function configFor(target: Target) {
  return makeConfig({
    provider: target.provider,
    model: target.model,
    // Only the mock has a degraded prompt; real providers vary by model.
    promptVersion: target.provider === "mock" && target.quality === "degraded" ? "v2-degraded" : "v1",
    toolset: ["search", "calculate"],
    temperature: 0,
  });
}

function clientFor(target: Target) {
  if (target.provider === "ollama") return createOllamaClient();
  if (target.provider === "gateway") return createGatewayClient();
  return createMockClient({ quality: target.quality });
}

const usd = (n: number) => `$${n.toFixed(6)}`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

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
      const { positional, flags } = parseFlags(rest);
      const quality = (positional[0] ?? "good") as MockQuality;
      const target = targetFrom(flags, quality);

      if (target.provider === "ollama" && !(await isOllamaRunning())) {
        throw new OllamaUnavailableError(DEFAULT_OLLAMA_HOST);
      }

      const { trace } = await record({
        agent: demoAgent,
        client: clientFor(target),
        config: configFor(target),
        input: DEMO_QUESTION,
        store,
        tags: target.provider === "mock" ? [quality] : [target.provider],
      });
      printTrace(trace);
      return 0;
    }

    case "models": {
      if (!(await isOllamaRunning())) throw new OllamaUnavailableError(DEFAULT_OLLAMA_HOST);
      const models = await listOllamaModels();
      console.log(bold(`local models  ${dim(DEFAULT_OLLAMA_HOST)}`));
      for (const model of models) console.log(`  ${model}`);
      if (models.length === 0) console.log(dim("  none — pull one with `ollama pull llama3.2:3b`"));
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
      const { positional, flags } = parseFlags(rest);
      const id = positional[0];
      if (!id) throw new Error("usage: fr replay <trace-id> [good|degraded] [--provider ollama]");
      const quality = (positional[1] ?? "degraded") as MockQuality;
      const target = targetFrom(flags, quality);

      const { baseline, candidate, mode, stub } = await replay({
        traceId: id,
        agent: demoAgent,
        client: clientFor(target),
        config: configFor(target),
        store,
        mode: (flags.get("mode") ?? "live") as ReplayMode,
      });
      console.log(bold("baseline"));
      printTrace(baseline);
      console.log();
      console.log(bold(`candidate  ${dim(`(${mode} mode)`)}`));
      printTrace(candidate);
      console.log();
      printNaiveDiff(baseline, candidate);

      if (stub) {
        console.log();
        console.log(bold("tool divergence") + dim("  (environment held still)"));
        console.log(`  served from recording  ${stub.exact} exact, ${stub.positional} loose`);
        for (const miss of stub.misses) {
          console.log(
            yellow(`  new call     `) + `${miss.tool}  ${dim(JSON.stringify(miss.input).slice(0, 70))}`,
          );
        }
        for (const unused of stub.unused) {
          console.log(
            yellow(`  never called `) + `${unused.tool}  ${dim("the baseline used it; this run did not")}`,
          );
        }
        if (stub.identical) console.log(dim("  identical to the baseline"));
      }
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

    case "freeze": {
      const { positional, flags } = parseFlags(rest);
      const id = positional[0];
      if (!id) throw new Error("usage: fr freeze <trace-id> [--suite name] [--drop 3,5] [--tag p0]");

      const trace = await store.get(id);
      if (!trace) throw new Error(`No trace with id ${id}`);

      const drop = (flags.get("drop") ?? "")
        .split(",")
        .map((n) => Number.parseInt(n.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0);

      const tags = (flags.get("tag") ?? "").split(",").map((t) => t.trim()).filter(Boolean);

      // Show what the run actually verified before showing the assertions.
      const literals = analyzeOutput(trace);
      const checked = literals.filter((l) => l.verifiedBy !== null);
      const unchecked = literals.filter((l) => l.verifiedBy === null);

      console.log(bold("claims in the answer"));
      for (const literal of checked) {
        console.log(`  ${green("verified")}  ${literal.value}  ${dim(`from ${literal.verifiedBy}`)}`);
      }
      for (const literal of unchecked) {
        console.log(`  ${yellow("unchecked")} ${literal.value}  ${dim("no tool produced this")}`);
      }
      if (literals.length === 0) console.log(dim("  (no literal claims found)"));

      const { testCase, proposals, dropped } = freeze({ trace, drop, tags });

      console.log();
      console.log(bold("assertions"));
      proposals.forEach((proposal, index) => {
        const n = index + 1;
        const isDropped = dropped.includes(proposal);
        const mark = isDropped ? dim("drop") : proposal.assertion.hard ? red("hard") : dim("soft");
        const label = `${String(n).padStart(2)}. ${mark} ${proposal.assertion.kind}(${proposal.assertion.value})`;
        console.log(isDropped ? dim(label) : label);
        console.log(dim(`      ${proposal.rationale}`));
      });

      const { path, replaced } = await suites.addCase(flags.get("suite") ?? "default", testCase);
      console.log();
      console.log(
        `${replaced ? "updated" : "added"} ${bold(testCase.id)} ` +
          `(${testCase.assertions.length} assertions) in ${path}`,
      );
      return 0;
    }

    case "cases": {
      const { flags } = parseFlags(rest);
      const names = flags.has("suite") ? [flags.get("suite")!] : await suites.list();
      if (names.length === 0) {
        console.log(dim("No suites yet. Run: npm run fr -- freeze <trace-id>"));
        return 0;
      }

      for (const name of names) {
        const suite = await suites.read(name);
        console.log(bold(`${name}  ${dim(`${suite.cases.length} cases`)}`));
        for (const testCase of suite.cases) {
          const hard = testCase.assertions.filter((a) => a.hard).length;
          console.log(
            `  ${testCase.id}  ${String(testCase.assertions.length).padStart(2)} assertions ` +
              `${dim(`(${hard} hard)`)}  ${dim(`from ${testCase.sourceTraceId}`)}` +
              (testCase.tags.length ? `  [${testCase.tags.join(", ")}]` : ""),
          );
        }
      }
      return 0;
    }

    case "check": {
      const { positional, flags } = parseFlags(rest);
      const [caseId, traceId] = positional;
      if (!caseId || !traceId) throw new Error("usage: fr check <case-id> <trace-id> [--suite name]");

      const suite = await suites.read(flags.get("suite") ?? "default");
      const testCase = suite.cases.find((c) => c.id === caseId);
      if (!testCase) throw new Error(`No case ${caseId} in suite ${suite.name}`);

      const trace = await store.get(traceId);
      if (!trace) throw new Error(`No trace with id ${traceId}`);

      const results = evaluateAll(testCase.assertions, trace);
      console.log(bold(`${testCase.id} vs ${traceId}`) + dim("   (tier 1 only — not scoring)"));

      let hardFailures = 0;
      for (const result of results) {
        const { assertion, pass, detail } = result;
        if (!pass && assertion.hard) hardFailures += 1;
        const mark = pass ? green("pass") : assertion.hard ? red("FAIL") : yellow("warn");
        console.log(
          `  ${mark}  ${assertion.kind}(${assertion.value})  ${dim(detail)}`,
        );
      }

      const passed = results.filter((r) => r.pass).length;
      console.log();
      console.log(
        `${passed}/${results.length} assertions passed` +
          (hardFailures > 0 ? red(`  ·  ${hardFailures} hard failures`) : ""),
      );
      return hardFailures > 0 ? 1 : 0;
    }

    case "matrix": {
      const { flags } = parseFlags(rest);
      const suite = await suites.read(flags.get("suite") ?? "default");
      if (suite.cases.length === 0) throw new Error(`Suite "${suite.name}" has no cases.`);

      const provider = flags.get("provider") ?? "ollama";
      const models = (flags.get("models") ?? DEFAULT_LOCAL_MODEL).split(",").map((m) => m.trim());
      const modes = (flags.get("modes") ?? "live,stubbed")
        .split(",")
        .map((m) => m.trim()) as ReplayMode[];

      const configs = models.map((model) =>
        configFor({ provider, model, quality: "good" }),
      );

      if (provider === "ollama" && !(await isOllamaRunning())) {
        throw new OllamaUnavailableError(DEFAULT_OLLAMA_HOST);
      }

      console.log(
        bold(
          `${suite.cases.length} cases × ${configs.length} configs × ${modes.length} modes ` +
            `= ${suite.cases.length * configs.length * modes.length} cells`,
        ),
      );

      const result = await runMatrix({
        cases: suite.cases,
        configs,
        modes,
        store,
        concurrency: Number(flags.get("concurrency") ?? 2),
        resume: flags.get("no-resume") !== "true",
        clientFor: (config) =>
          clientFor({ provider: config.provider, model: config.model, quality: "good" }),
        onEvent: (event) => {
          if (event.type === "start" && event.skipped > 0) {
            console.log(dim(`resuming — ${event.skipped} cells already done`));
          }
          if (event.type === "cell-retry") {
            console.log(
              yellow(`  retry ${event.attempt} in ${event.delayMs}ms`) + dim(`  ${event.reason}`),
            );
          }
          if (event.type === "cell-done") {
            const { cell, trace, stub, resumed } = event.result;
            const ok = event.result.attempt.error === null;
            const mark = resumed ? dim("skip") : ok ? green("ok  ") : red("err ");
            const divergence =
              stub && !stub.identical
                ? dim(
                    `  stub: ${stub.exact} exact, ${stub.positional} loose, ` +
                      `${stub.misses.length} miss, ${stub.unused.length} unused`,
                  )
                : "";
            console.log(
              `  ${mark} ${cell.config.model.padEnd(14)} ${cell.mode.padEnd(8)} ` +
                dim(trace ? `${trace.totals.wallMs}ms` : "—") +
                divergence,
            );
          }
        },
      });

      console.log();
      console.log(
        `${result.ran} ran · ${result.resumed} resumed · ` +
          (result.failed > 0 ? red(`${result.failed} could not run`) : "0 could not run"),
      );

      // Tier-1 evaluation only — the statistical report is phase 5.
      const byConfig = new Map<string, { pass: number; total: number }>();
      for (const cellResult of result.results) {
        if (!cellResult.trace) continue;
        const key = `${cellResult.cell.config.model} ${cellResult.cell.mode}`;
        const bucket = byConfig.get(key) ?? { pass: 0, total: 0 };
        const results = evaluateAll(cellResult.cell.testCase.assertions, cellResult.trace);
        bucket.pass += results.filter((r) => r.pass).length;
        bucket.total += results.length;
        byConfig.set(key, bucket);
      }

      if (byConfig.size > 0) {
        console.log();
        console.log(bold("tier-1 assertions") + dim("  (not scoring — no judge, no statistics)"));
        for (const [key, bucket] of byConfig) {
          const rate = bucket.total > 0 ? (bucket.pass / bucket.total) * 100 : 0;
          console.log(
            `  ${key.padEnd(24)} ${String(bucket.pass).padStart(3)}/${String(bucket.total).padEnd(3)}` +
              `  ${rate.toFixed(0)}%`,
          );
        }
      }
      return 0;
    }

    case "agents": {
      for (const agent of listAgents()) {
        console.log(`  ${agent.ref.name}@${agent.ref.version}`);
      }
      return 0;
    }

    case "price": {
      const at = rest[0] ? new Date(rest[0]) : new Date();
      if (Number.isNaN(at.getTime())) throw new Error("usage: fr price [YYYY-MM-DD]");

      console.log(bold(`Cost table  ${dim(`as of ${at.toISOString().slice(0, 10)}`)}`));
      console.log(
        dim("  model".padEnd(26) + "in $/MTok".padStart(12) + "out $/MTok".padStart(12)),
      );
      for (const model of Object.keys(PRICES)) {
        const p = priceFor(model, at);
        console.log(
          `  ${model.padEnd(24)}${p.inputPerMTok.toFixed(2).padStart(12)}${p.outputPerMTok
            .toFixed(2)
            .padStart(12)}${p.intro ? dim("  intro") : ""}`,
        );
      }
      console.log(
        dim(
          `\n  cache: read ×${CACHE_MULTIPLIERS.read}, write ×${CACHE_MULTIPLIERS.write5m} (5m) / ` +
            `×${CACHE_MULTIPLIERS.write1h} (1h), applied to the input rate`,
        ),
      );
      return 0;
    }

    case "stats": {
      const s = await store.stats();
      const d = await store.dedupeStats();
      const saved = d.naiveBytes > 0 ? 1 - d.storedBytes / d.naiveBytes : 0;
      console.log(
        `traces ${s.traces} · payloads ${s.blobs} · ${(s.bytes / 1024).toFixed(1)} KiB stored`,
      );
      console.log(
        dim(
          `dedupe ${d.references} references to ${d.uniquePayloads} unique payloads · ` +
            `${(saved * 100).toFixed(1)}% smaller than storing them inline`,
        ),
      );
      console.log(dim(`db     ${store.path}`));
      return 0;
    }

    default:
      console.log(`fr — Flight Recorder (phase 2)

  record [good|degraded]        run the demo agent and store the trace
  ls [limit]                    list stored traces
  show <trace-id>               print one trace with its spans
  replay <trace-id> [quality]   re-run a trace's input under a new config
      --mode live|stubbed         stubbed plays recorded tool responses back
  diff <baseline> <candidate>   naive side-by-side (NOT scoring)

  freeze <trace-id>             promote a trace to a test case
      --suite <name>              suite to write to (default: default)
      --drop 3,5                  leave out proposals by number
      --tag p0,billing            tags for the case
  cases [--suite <name>]        list frozen cases
  check <case-id> <trace-id>    evaluate a case's assertions (tier 1 only)

  matrix                        run every case across every config and mode
      --suite <name>              suite to run (default: default)
      --models a,b                comma-separated model ids
      --modes live,stubbed        which replay modes to run
      --concurrency 2             cells in flight
      --no-resume                 re-run cells that already have attempts
  agents                        list registered agents

  price [YYYY-MM-DD]            cost table, with promotional rates resolved
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
