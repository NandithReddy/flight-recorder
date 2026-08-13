/**
 * Suite storage — the file format test cases live in.
 *
 * Traces are data and belong in the database: large, numerous, machine-written,
 * nobody reviews them. Test cases are code and belong in git: small, few,
 * human-approved, and a change to one should show up in a pull request exactly
 * like a change to a unit test.
 *
 * So this writes plain JSON to a committed directory, with a fixed key order
 * and stable formatting, because the thing that makes a file reviewable is that
 * the diff shows only what actually changed.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Assertion, TestCase } from "../core/types.ts";

/** Committed, unlike the dot-prefixed local trace store. */
export const DEFAULT_SUITE_DIR = "flightrecorder/suites";

export interface SuiteFile {
  name: string;
  /** Pins the baseline for reproducibility; set by the CI gate in phase 6. */
  baselineCommit: string | null;
  cases: TestCase[];
}

const CASE_KEYS = [
  "id",
  "agent",
  "sourceTraceId",
  "baselineTraceId",
  "tags",
  "createdAt",
  "input",
  "rubric",
  "assertions",
] as const;

const ASSERTION_KEYS = ["id", "kind", "value", "hard", "note"] as const;

function ordered<T extends object>(value: T, keys: readonly string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in source) out[key] = source[key];
  // Anything the key list does not know about still gets written, so a future
  // field cannot be silently dropped by an older writer.
  for (const key of Object.keys(source)) if (!(key in out)) out[key] = source[key];
  return out;
}

/** Deterministic, indented, and ordered for reading rather than for machines. */
export function formatSuite(suite: SuiteFile): string {
  const body = {
    name: suite.name,
    baselineCommit: suite.baselineCommit,
    cases: suite.cases.map((testCase) => ({
      ...ordered(testCase, CASE_KEYS),
      assertions: (testCase.assertions as Assertion[]).map((a) => ordered(a, ASSERTION_KEYS)),
    })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export class SuiteStore {
  #dir: string;

  constructor(dir: string = DEFAULT_SUITE_DIR) {
    this.#dir = dir;
  }

  get dir(): string {
    return this.#dir;
  }

  #pathFor(name: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      throw new Error(
        `Invalid suite name "${name}". Use letters, digits, dot, dash or underscore.`,
      );
    }
    return join(this.#dir, `${name}.json`);
  }

  async read(name: string): Promise<SuiteFile> {
    const path = this.#pathFor(name);
    if (!existsSync(path)) return { name, baselineCommit: null, cases: [] };

    const parsed = JSON.parse(await readFile(path, "utf8")) as SuiteFile;
    return { name: parsed.name ?? name, baselineCommit: parsed.baselineCommit ?? null, cases: parsed.cases ?? [] };
  }

  async write(suite: SuiteFile): Promise<string> {
    const path = this.#pathFor(suite.name);
    await mkdir(this.#dir, { recursive: true });
    await writeFile(path, formatSuite(suite), "utf8");
    return path;
  }

  /** Appends a case, replacing any earlier case frozen from the same trace. */
  async addCase(name: string, testCase: TestCase): Promise<{ path: string; replaced: boolean }> {
    const suite = await this.read(name);
    const index = suite.cases.findIndex((c) => c.sourceTraceId === testCase.sourceTraceId);

    const replaced = index !== -1;
    if (replaced) suite.cases[index] = testCase;
    else suite.cases.push(testCase);

    return { path: await this.write(suite), replaced };
  }

  async list(): Promise<string[]> {
    if (!existsSync(this.#dir)) return [];
    return (await readdir(this.#dir))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length))
      .sort();
  }
}
