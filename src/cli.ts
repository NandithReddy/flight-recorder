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
import { DEMO_QUESTION, demoAgent, TASKS } from "../examples/demo-agent.ts";
import { runMatrix } from "./replay/matrix.ts";
import { listAgents } from "./replay/registry.ts";
import "../examples/register.ts";
import { createInterface } from "node:readline/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildReport, headline } from "./report/build.ts";
import { renderReportHtml } from "./report/html.ts";
import { describeInterval } from "./stats/bootstrap.ts";
import { evaluateGate, formatGate } from "./gate/gate.ts";
import {
  checkSuiteRunnable,
  currentCommit,
  exportSuiteTraces,
  importTraceBundle,
} from "./store/portable.ts";
import { createJudge, DEFAULT_JUDGE_PROMPT } from "./score/judge.ts";
import { calibrate, MIN_LABELS } from "./score/calibration.ts";
import {
  formatConfusion,
  interpretKappa,
  isTrustworthy,
  TRUST_THRESHOLD,
} from "./score/kappa.ts";
import {
  labelledItems,
  LabelStore,
  resolveChoice,
  unlabelledItems,
  type NewLabelItem,
} from "./score/labels.ts";
import type { ReplayMode, Trace } from "./core/types.ts";

const store = new SqliteTraceStore();
const suites = new SuiteStore();
const labels = new LabelStore();

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
  temperature?: number;
  promptVersion?: string;
}

function targetFrom(flags: Map<string, string>, quality: MockQuality): Target {
  const provider = flags.get("provider") ?? "mock";
  const model =
    flags.get("model") ?? (provider === "ollama" ? DEFAULT_LOCAL_MODEL : "demo-model");
  const temp = flags.get("temp");
  return {
    provider,
    model,
    quality,
    temperature: temp === undefined ? 0 : Number(temp),
    ...(flags.has("prompt") ? { promptVersion: flags.get("prompt")! } : {}),
  };
}

function configFor(target: Target) {
  return makeConfig({
    provider: target.provider,
    model: target.model,
    promptVersion:
      target.promptVersion ??
      // The mock's "degraded" flag is its own prompt variant.
      (target.provider === "mock" && target.quality === "degraded" ? "v2-degraded" : "v1"),
    toolset: ["search", "calculate"],
    temperature: target.temperature ?? 0,
  });
}

function clientFor(target: Target) {
  if (target.provider === "ollama") return createOllamaClient();
  if (target.provider === "gateway") return createGatewayClient();
  // The mock's "degraded" variant *is* its v2-degraded prompt, so selecting a
  // prompt in the matrix has to select it. Without this the mock could only
  // ever run its good path and could not demonstrate a regression at all.
  const quality: MockQuality =
    target.promptVersion === "v2-degraded" ? "degraded" : target.quality;
  return createMockClient({ quality });
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

      // "model@0.7" varies temperature as well as model, and --prompts crosses
      // prompt variants over all of them. Model, temperature and prompt are all
      // config, so all three belong in the matrix.
      const prompts = (flags.get("prompts") ?? "v1").split(",").map((p) => p.trim());
      const configs = models.flatMap((entry) => {
        const [model, temp] = entry.split("@");
        return prompts.map((promptVersion) =>
          configFor({
            provider,
            model: model!,
            quality: "good",
            temperature: temp === undefined ? 0 : Number(temp),
            promptVersion,
          }),
        );
      });

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
          clientFor({
            provider: config.provider,
            model: config.model,
            quality: "good",
            temperature: config.temperature,
            promptVersion: config.promptVersion,
          }),
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

    case "seed": {
      const { flags } = parseFlags(rest);
      const target = targetFrom(flags, "good");
      const suiteName = flags.get("suite") ?? "default";
      const limit = Number(flags.get("limit") ?? TASKS.length);

      if (target.provider === "ollama" && !(await isOllamaRunning())) {
        throw new OllamaUnavailableError(DEFAULT_OLLAMA_HOST);
      }

      const tasks = TASKS.slice(0, limit);
      console.log(bold(`recording ${tasks.length} tasks on ${target.model}`));

      let frozen = 0;
      for (const [index, task] of tasks.entries()) {
        const { trace } = await record({
          agent: demoAgent,
          client: clientFor(target),
          config: configFor(target),
          input: task,
          store,
          tags: ["seed"],
        });

        if (trace.error) {
          console.log(`  ${red("err ")} ${String(index + 1).padStart(2)}. ${dim(trace.error.message)}`);
          continue;
        }

        try {
          const { testCase } = freeze({ trace });
          await suites.addCase(suiteName, testCase);
          frozen += 1;
          console.log(
            `  ${green("ok  ")} ${String(index + 1).padStart(2)}. ` +
              `${String(testCase.assertions.length).padStart(2)} assertions  ${dim(task.slice(0, 52))}`,
          );
        } catch (error) {
          console.log(
            `  ${yellow("skip")} ${String(index + 1).padStart(2)}. ` +
              dim(error instanceof Error ? error.message.split("\n")[0]! : String(error)),
          );
        }
      }

      console.log();
      console.log(`${frozen} cases in suite "${suiteName}"`);
      return 0;
    }

    case "pool": {
      const { flags } = parseFlags(rest);
      const suite = await suites.read(flags.get("suite") ?? "default");
      const setName = flags.get("set") ?? "default";

      const pairs: NewLabelItem[] = [];
      for (const testCase of suite.cases) {
        const baseline = await store.get(testCase.baselineTraceId);
        if (!baseline) continue;

        for (const attempt of store.listAttempts(testCase.id)) {
          if (attempt.traceId === "" || attempt.traceId === baseline.id) continue;
          const candidate = await store.get(attempt.traceId);
          if (!candidate) continue;

          pairs.push({
            task: String(testCase.input),
            baseline: String(baseline.output ?? ""),
            candidate: String(candidate.output ?? ""),
            caseId: testCase.id,
            baselineTraceId: baseline.id,
            candidateTraceId: candidate.id,
            baselineModel: baseline.config.model,
            candidateModel: candidate.config.model,
          });
        }
      }

      const { set, added, skipped } = await labels.addItems(setName, pairs);
      console.log(
        `${added} pairs added, ${skipped} skipped as duplicate or identical.\n` +
          `"${setName}" now holds ${set.items.length} pairs, ` +
          `${unlabelledItems(set).length} awaiting a label.`,
      );
      if (added > 0) console.log(dim(`\nLabel them with:  npm run fr -- label --set ${setName}`));
      return 0;
    }

    case "label": {
      const { flags } = parseFlags(rest);
      const setName = flags.get("set") ?? "default";
      const set = await labels.read(setName);
      const queue = unlabelledItems(set).slice(0, Number(flags.get("limit") ?? 1000));

      if (queue.length === 0) {
        const done = labelledItems(set).length;
        console.log(
          done > 0
            ? `All ${done} pairs in "${setName}" are labelled.`
            : `"${setName}" is empty. Build it with: npm run fr -- pool --set ${setName}`,
        );
        return 0;
      }

      console.log(bold(`Labelling "${setName}" — ${queue.length} pairs to go`));
      console.log(
        dim(
          "You are shown two answers to the same task, in a random order, without\n" +
            "being told which came from where. Pick the better one.\n" +
            "  1 = first answer   2 = second answer   t = equally good   s = skip   q = save and quit\n",
        ),
      );

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let labelled = 0;

      try {
        for (const [index, item] of queue.entries()) {
          const first = item.presentedFirst === "baseline" ? item.baseline : item.candidate;
          const second = item.presentedFirst === "baseline" ? item.candidate : item.baseline;

          console.log(bold(`\n[${index + 1}/${queue.length}]  ${item.task}`));
          console.log(`\n  ${bold("1.")} ${first}`);
          console.log(`\n  ${bold("2.")} ${second}`);

          const answer = (await rl.question("\n  better? [1/2/t/s/q] ")).trim().toLowerCase();
          if (answer === "q") break;
          if (answer === "s" || answer === "") continue;
          if (!["1", "2", "t"].includes(answer)) {
            console.log(dim("  unrecognised — skipping"));
            continue;
          }

          item.human = resolveChoice(item, answer === "t" ? "tie" : (answer as "1" | "2"));
          item.labelledAt = Date.now();
          labelled += 1;
          // Save after every label: a crash must never cost a person's work.
          await labels.write(set);
        }
      } finally {
        rl.close();
      }

      const total = labelledItems(set).length;
      console.log(`\n${labelled} labelled this session · ${total} labelled in total.`);
      if (total < MIN_LABELS) {
        console.log(dim(`Calibration needs at least ${MIN_LABELS}.`));
      } else {
        console.log(dim(`Ready to calibrate:  npm run fr -- calibrate --set ${setName}`));
      }
      return 0;
    }

    case "calibrate": {
      const { flags } = parseFlags(rest);
      const setName = flags.get("set") ?? "default";
      const set = await labels.read(setName);
      const judgeModel = flags.get("judge") ?? "qwen2.5:7b";

      if (!(await isOllamaRunning())) throw new OllamaUnavailableError(DEFAULT_OLLAMA_HOST);

      const total = labelledItems(set).length;
      console.log(
        bold(`calibrating ${judgeModel} against ${total} human labels`) +
          dim(`  (judge prompt ${flags.get("judge-prompt") ?? DEFAULT_JUDGE_PROMPT})`),
      );

      const judgePromptVersion = flags.get("judge-prompt") ?? DEFAULT_JUDGE_PROMPT;
      const result = await calibrate({
        set,
        judge: createJudge({
          client: createOllamaClient(),
          model: judgeModel,
          promptVersion: judgePromptVersion,
        }),
        judgeModel,
        judgePromptVersion,
        measurePositionBias: flags.get("position-bias") === "true",
        onProgress: (done, n) => {
          if (done % 10 === 0 || done === n) process.stdout.write(`\r  ${done}/${n}`);
        },
      });
      process.stdout.write("\n\n");

      const k = result.kappa;
      const trusted = isTrustworthy(k.kappa);
      console.log(
        `${bold("kappa")}  ${k.kappa.toFixed(3)}  ` +
          `${dim(`(${k.interval.lower.toFixed(3)} to ${k.interval.upper.toFixed(3)}, 95%)`)}  ` +
          (trusted ? green(interpretKappa(k.kappa)) : red(`${interpretKappa(k.kappa)} — below ${TRUST_THRESHOLD}`)),
      );
      console.log(
        dim(
          `raw agreement ${(k.observedAgreement * 100).toFixed(1)}% · ` +
            `chance alone would give ${(k.expectedAgreement * 100).toFixed(1)}%`,
        ),
      );
      console.log();
      for (const line of formatConfusion(k)) console.log(dim(`  ${line}`));

      console.log();
      console.log(
        dim(
          `unreadable replies ${(result.stored.unparsedRate * 100).toFixed(1)}%` +
            (result.stored.positionFlipRate !== null
              ? ` · position flips ${(result.stored.positionFlipRate * 100).toFixed(1)}%`
              : "") +
            ` · judge used ${result.usage.inputTokens + result.usage.outputTokens} tokens`,
        ),
      );

      const path = await labels.writeCalibration(setName, result.stored);
      console.log(dim(`\nwritten to ${path}`));

      if (!trusted) {
        console.log(
          yellow(
            `\nThis judge is not trustworthy enough to gate on. Verdicts it produces\n` +
              `will be marked untrusted in the report. Try a stronger judge model.`,
          ),
        );
      }
      return trusted ? 0 : 1;
    }

    case "report": {
      const { flags } = parseFlags(rest);
      const suite = await suites.read(flags.get("suite") ?? "default");
      if (suite.cases.length === 0) throw new Error(`Suite "${suite.name}" has no cases.`);

      const provider = flags.get("provider") ?? "ollama";
      // "model@temp#prompt" — every axis a config can vary.
      const parseTarget = (spec: string) => {
        const [modelAndTemp, promptVersion] = spec.split("#");
        const [model, temp] = modelAndTemp!.split("@");
        return configFor({
          provider,
          model: model!,
          quality: "good",
          temperature: temp === undefined ? 0 : Number(temp),
          ...(promptVersion ? { promptVersion } : {}),
        });
      };

      const baselineSpec = flags.get("baseline");
      const candidateSpec = flags.get("candidate");
      if (!baselineSpec || !candidateSpec) {
        throw new Error(
          "usage: fr report --baseline <model[@temp]> --candidate <model[@temp]> [--suite name]",
        );
      }

      // A calibrated judge is opt-in: without --set the report is tier 1 only,
      // which is honest rather than silently unjudged.
      const labelSetName = flags.get("set");
      const calibration = labelSetName ? await labels.readCalibration(labelSetName) : null;
      const judgeModel = flags.get("judge") ?? calibration?.judgeModel ?? null;
      const useJudge = flags.get("no-judge") !== "true" && judgeModel !== null;

      if (useJudge && !(await isOllamaRunning())) {
        throw new OllamaUnavailableError(DEFAULT_OLLAMA_HOST);
      }

      const report = await buildReport({
        suite,
        store,
        baselineConfig: parseTarget(baselineSpec),
        candidateConfig: parseTarget(candidateSpec),
        mode: (flags.get("mode") ?? "live") as ReplayMode,
        judge: useJudge
          ? createJudge({ client: createOllamaClient(), model: judgeModel! })
          : null,
        judgeModel: judgeModel ?? undefined,
        trust: calibration?.kappa ?? null,
      });

      console.log(bold(headline(report)));

      // A fresh clone has the baselines but has never run anything, so there is
      // nothing to compare. Say what to do rather than printing a row of NaN.
      if (report.n === 0) {
        console.log(
          dim(
            `\n  ${suite.cases.length} cases are loaded, but neither config has been run here yet.\n` +
              `  Produce the candidate runs first:\n`,
          ),
        );
        console.log(
          `    npm run fr -- matrix --suite ${suite.name} ` +
            `--models ${flags.get("candidate")} --modes live\n`,
        );
        return 0;
      }

      console.log();
      console.log(
        `  pass rate    ${report.passRateBefore.toFixed(1)}% → ${report.passRateAfter.toFixed(1)}%` +
          `   ${describeInterval(report.passRateDelta, "%")}`,
      );
      console.log(
        `  cost/task    $${report.costPerTaskBefore.toFixed(6)} → $${report.costPerTaskAfter.toFixed(6)}`,
      );
      console.log(
        `  latency p95  ${Math.round(report.latencyP95Before)}ms → ${Math.round(report.latencyP95After)}ms`,
      );

      if (report.regressions.length > 0) {
        console.log();
        console.log(red(`  ${report.regressions.length} regressions`));
        for (const outcome of report.regressions) {
          console.log(`    · ${outcome.task}`);
        }
      }
      if (report.fixes.length > 0) {
        console.log(green(`  ${report.fixes.length} newly passing`));
      }
      if (report.untrustedVerdicts > 0) {
        console.log(
          yellow(
            `\n  ${report.untrustedVerdicts} verdicts marked untrusted — the judge is not ` +
              `calibrated well enough to gate on.`,
          ),
        );
      }

      const outPath = flags.get("out") ?? "flightrecorder/report.html";
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, await renderReportHtml({ report, store }), "utf8");
      console.log(dim(`\nwritten to ${outPath}`));

      return report.regressions.length > 0 ? 1 : 0;
    }

    case "gate": {
      const { flags } = parseFlags(rest);
      const suite = await suites.read(flags.get("suite") ?? "default");
      const provider = flags.get("provider") ?? "ollama";

      const parseTarget = (spec: string) => {
        const [modelAndTemp, promptVersion] = spec.split("#");
        const [model, temp] = modelAndTemp!.split("@");
        return configFor({
          provider,
          model: model!,
          quality: "good",
          temperature: temp === undefined ? 0 : Number(temp),
          ...(promptVersion ? { promptVersion } : {}),
        });
      };

      const baselineSpec = flags.get("baseline");
      const candidateSpec = flags.get("candidate");
      if (!baselineSpec || !candidateSpec) {
        throw new Error("usage: fr gate --baseline <spec> --candidate <spec> [--suite name]");
      }

      const labelSetName = flags.get("set");
      const calibration = labelSetName ? await labels.readCalibration(labelSetName) : null;
      const judgeModel = flags.get("judge") ?? calibration?.judgeModel ?? null;
      const useJudge = flags.get("no-judge") !== "true" && judgeModel !== null;

      const report = await buildReport({
        suite,
        store,
        baselineConfig: parseTarget(baselineSpec),
        candidateConfig: parseTarget(candidateSpec),
        mode: (flags.get("mode") ?? "live") as ReplayMode,
        ...(flags.get("baseline-committed") === "true"
          ? { baselineSource: "committed" as const }
          : {}),
        judge: useJudge ? createJudge({ client: createOllamaClient(), model: judgeModel! }) : null,
        judgeModel: judgeModel ?? undefined,
        trust: calibration?.kappa ?? null,
      });

      const result = evaluateGate(report, {
        ...(flags.has("critical-tag") ? { criticalTag: flags.get("critical-tag")! } : {}),
        ...(flags.has("max-cost") ? { maxCostPerTaskUsd: Number(flags.get("max-cost")) } : {}),
        ...(flags.has("max-latency") ? { maxLatencyP95Ms: Number(flags.get("max-latency")) } : {}),
        ...(flags.get("fail-on-any-regression") === "true"
          ? { failOnAnyRegression: true }
          : {}),
      });

      const text = formatGate(report, result);
      console.log(result.status === "pass" ? green(text) : red(text));

      if (flags.has("out")) {
        const outPath = flags.get("out")!;
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, await renderReportHtml({ report, store }), "utf8");
        console.log(dim(`\nreport written to ${outPath}`));
      }
      return result.exitCode;
    }

    case "export": {
      const { flags } = parseFlags(rest);
      const suite = await suites.read(flags.get("suite") ?? "default");
      const path = flags.get("out") ?? `flightrecorder/traces/${suite.name}.traces.json`;

      const result = await exportSuiteTraces({ suite, store, path });
      console.log(
        `${result.exported} traces → ${result.path} ` +
          dim(`(${(result.bytes / 1024).toFixed(0)} KiB)`),
      );
      if (result.missing.length > 0) {
        console.log(yellow(`  ${result.missing.length} referenced traces are not in this store`));
      }

      // Pin the suite to the commit its baselines were exported at.
      const commit = result.bundle.commit;
      if (commit) {
        await suites.write({ ...suite, baselineCommit: commit });
        console.log(dim(`  pinned baseline to ${commit.slice(0, 12)}`));
      } else {
        console.log(
          dim("  not pinned — the working tree is dirty, and a pin that does not"),
        );
        console.log(dim("  describe the tree looks reproducible without being so."));
      }
      return 0;
    }

    case "import": {
      const { flags } = parseFlags(rest);
      const name = flags.get("suite") ?? "default";
      const path = flags.get("in") ?? `flightrecorder/traces/${name}.traces.json`;

      const result = await importTraceBundle({ store, path });
      console.log(`${result.imported} traces imported, ${result.skipped} already present.`);
      if (result.commit) console.log(dim(`  bundle was exported at ${result.commit.slice(0, 12)}`));

      const suite = await suites.read(name);
      const check = await checkSuiteRunnable(suite, store);
      console.log(
        check.runnable
          ? green(`  suite "${name}" is runnable here.`)
          : red(`  suite "${name}" still needs ${check.missing.length} traces.`),
      );
      return check.runnable ? 0 : 1;
    }

    case "doctor": {
      const { flags } = parseFlags(rest);
      const name = flags.get("suite") ?? "default";
      const suite = await suites.read(name);
      const check = await checkSuiteRunnable(suite, store);
      const commit = await currentCommit();

      console.log(bold(`suite "${name}"`));
      console.log(`  cases            ${suite.cases.length}`);
      console.log(`  baseline pinned  ${suite.baselineCommit ?? dim("not pinned")}`);
      console.log(`  working tree     ${commit ? `clean at ${commit.slice(0, 12)}` : "dirty"}`);
      console.log(
        `  traces present   ${check.runnable ? green("all") : red(`${check.missing.length} missing`)}`,
      );

      const attempts = suite.cases.reduce(
        (total, testCase) => total + store.listAttempts(testCase.id).length,
        0,
      );
      console.log(
        `  runs recorded    ${attempts === 0 ? dim("none yet") : `${attempts} attempts`}`,
      );

      if (!check.runnable) {
        console.log(dim(`\n  Load the baselines:  npm run fr -- import --suite ${name}`));
      } else if (attempts === 0) {
        console.log(
          dim(
            `\n  Baselines are here, but nothing has been run against them yet.\n` +
              `  Next:  npm run fr -- matrix --suite ${name} --models <model>`,
          ),
        );
      }
      return check.runnable ? 0 : 1;
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

  seed                          record every task and freeze each as a case
      --suite <name> --limit N    where to write, how many tasks
      --prompt <version>          which prompt variant to record with
  matrix                        run every case across every config and mode
      --suite <name>              suite to run (default: default)
      --models a,b@0.7            model ids, optionally with @temperature
      --prompts v1,v0             prompt variants, crossed with the models
      --modes live,stubbed        which replay modes to run
      --concurrency 2             cells in flight
      --no-resume                 re-run cells that already have attempts
  agents                        list registered agents

  gate                          run the report and decide pass/fail (exit 0/1)
      --baseline/--candidate      same specs as report
      --baseline-committed        compare against the frozen reference, not a
                                  fresh run — catches uniform regressions
      --critical-tag p0           one regression here fails the build
      --max-cost / --max-latency  ceilings
      --fail-on-any-regression    block on any regression, significant or not
  export --suite <name>         write the suite's traces to git, pin the commit
  import --suite <name>         load a suite's traces into this store
  doctor --suite <name>         can this suite run here?

  report                        compare two configs, with intervals
      --baseline <model[@temp][#prompt]>   the side to compare against
      --candidate <model[@temp][#prompt]>  the side under test
      --suite <name> --mode live  which cases, which replay mode
      --set <name>                use that label set's calibrated judge
      --no-judge                  deterministic assertions only
      --out <path>                default flightrecorder/report.html

  pool --set <name>             build judge-vs-human pairs from stored attempts
  label --set <name>            label pairs blind (1 / 2 / t / s / q)
  calibrate --set <name>        measure the judge against those labels
      --judge <model>             judge model (default qwen2.5:7b)
      --judge-prompt <version>    judge prompt variant (v1, v2)
      --position-bias             also run both orders to measure bias

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
