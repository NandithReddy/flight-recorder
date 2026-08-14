/**
 * The cross-loop comparison, as a script rather than a remembered number.
 *
 * Both suites cover the same thirty tasks, but each was frozen from its own
 * baseline, so their assertion sets differ (129 hard assertions against 125).
 * Comparing those two rates directly compares two rulers as well as two agent
 * loops. This scores *both* loops' stored traces against *one* assertion set —
 * the metrics suite's, frozen from the hand-rolled baseline — matched task by
 * task on the input text.
 *
 *   node scripts/loop-compare.ts
 *
 * It reads only what is already in the store, so it costs no inference. Run
 * the two matrices first if the store is empty:
 *
 *   npm run fr -- matrix --suite metrics --models qwen2.5:7b,llama3.2:3b --modes live,stubbed
 *   npm run fr -- matrix --suite react   --models qwen2.5:7b,llama3.2:3b --modes live,stubbed
 */

import { DatabaseSync } from "node:sqlite";

import { evaluateAll } from "../src/freeze/assertions.ts";
import { SuiteStore } from "../src/freeze/suite.ts";
import { SqliteTraceStore } from "../src/store/sqlite-store.ts";
import type { Assertion, TestCase } from "../src/core/types.ts";

const STORE_DIR = ".flightrecorder";

interface Bucket {
  loop: string;
  model: string;
  mode: string;
  hardPass: number;
  hardTotal: number;
  cases: number;
  casesPassed: number;
  died: number;
  toolErrors: number;
}

const store = new SqliteTraceStore(STORE_DIR);
const suites = new SuiteStore();
const db = new DatabaseSync(`${STORE_DIR}/traces.db`, { readOnly: true });

const attempts = db
  .prepare("select case_id, mode, trace_id from attempts where trace_id is not null and trace_id != ''")
  .all() as { case_id: string; mode: string; trace_id: string }[];

const metrics = await suites.read("metrics");
const react = await suites.read("react");

/** One ruler for both loops: the assertions frozen from the hand-rolled runs. */
const rulerFor = new Map<string, Assertion[]>(
  metrics.cases.map((testCase) => [
    JSON.stringify(testCase.input),
    testCase.assertions as Assertion[],
  ]),
);

const buckets = new Map<string, Bucket>();

async function tally(loop: string, cases: TestCase[]): Promise<void> {
  const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));

  for (const row of attempts) {
    const testCase = byId.get(row.case_id);
    if (!testCase) continue;

    const assertions = rulerFor.get(JSON.stringify(testCase.input));
    if (!assertions) continue;

    const trace = await store.get(row.trace_id);
    if (!trace) continue;

    const key = `${loop}|${trace.config.model}|${row.mode}`;
    const bucket: Bucket = buckets.get(key) ?? {
      loop,
      model: trace.config.model,
      mode: row.mode,
      hardPass: 0,
      hardTotal: 0,
      cases: 0,
      casesPassed: 0,
      died: 0,
      toolErrors: 0,
    };

    const hard = evaluateAll(assertions, trace).filter((result) => result.assertion.hard);
    bucket.hardPass += hard.filter((result) => result.pass).length;
    bucket.hardTotal += hard.length;
    bucket.cases += 1;
    if (hard.every((result) => result.pass)) bucket.casesPassed += 1;
    if (trace.error) bucket.died += 1;
    bucket.toolErrors += trace.spans.filter((span) => span.kind === "tool" && span.error).length;

    buckets.set(key, bucket);
  }
}

await tally("hand-rolled", metrics.cases as TestCase[]);
await tally("ReAct", react.cases as TestCase[]);

const pct = (part: number, whole: number): string =>
  whole === 0 ? "   —" : `${((part / whole) * 100).toFixed(0).padStart(3)}%`;

if (buckets.size === 0) {
  console.log("Nothing to compare — no stored attempts for either suite.");
} else {
  console.log("both loops scored against the metrics suite's assertions — same 30 tasks, one ruler\n");
  console.log("  loop         model         mode      hard assertions  cases passed  runs died  tool errors");

  const ordered = [...buckets.values()].sort(
    (a, b) =>
      a.model.localeCompare(b.model) ||
      a.mode.localeCompare(b.mode) ||
      b.loop.localeCompare(a.loop),
  );

  for (const bucket of ordered) {
    console.log(
      `  ${bucket.loop.padEnd(12)} ${bucket.model.padEnd(13)} ${bucket.mode.padEnd(9)} ` +
        `${String(bucket.hardPass).padStart(3)}/${String(bucket.hardTotal).padEnd(4)} ${pct(bucket.hardPass, bucket.hardTotal)}   ` +
        `${String(bucket.casesPassed).padStart(2)}/${bucket.cases} ${pct(bucket.casesPassed, bucket.cases)}    ` +
        `${String(bucket.died).padStart(2)}/${bucket.cases}      ${bucket.toolErrors}`,
    );
  }
}

db.close();
store.close();
