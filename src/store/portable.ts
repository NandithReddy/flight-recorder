/**
 * Making a suite portable.
 *
 * A committed suite is useless on its own: every case points at a
 * `baselineTraceId` that lives in a local, gitignored database. Clone the repo
 * and every case fails with "trace not in the store" — which means the suite is
 * not a fixture, it is a note about one laptop.
 *
 * Export writes the traces a suite depends on into a single JSON file that goes
 * into git beside it. Import loads them back. The suite then travels with
 * everything it needs, which is what the phase 7 criterion — "npm i to first
 * report in under twenty minutes on someone else's machine" — actually requires.
 *
 * The bundle also pins the commit it was made at, so a comparison months later
 * can say what it was comparing against rather than guessing.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Trace } from "../core/types.ts";
import type { SuiteFile } from "../freeze/suite.ts";
import type { TraceStore } from "./types.ts";

const run = promisify(execFile);

export const BUNDLE_VERSION = 1 as const;

export interface TraceBundle {
  version: typeof BUNDLE_VERSION;
  suite: string;
  /** Git commit the bundle was exported at, when the tree was clean. */
  commit: string | null;
  createdAt: number;
  traces: Trace[];
}

/**
 * The commit to pin to, or null.
 *
 * Returns null on a dirty tree rather than a commit hash: pinning a baseline to
 * a commit that does not describe the working tree is worse than not pinning at
 * all, because it looks reproducible and is not.
 */
export async function currentCommit(cwd = process.cwd()): Promise<string | null> {
  try {
    const { stdout: status } = await run("git", ["status", "--porcelain"], { cwd });
    if (status.trim() !== "") return null;
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Every trace id a suite needs in order to run. */
export function requiredTraceIds(suite: SuiteFile): string[] {
  const ids = new Set<string>();
  for (const testCase of suite.cases) {
    ids.add(testCase.baselineTraceId);
    ids.add(testCase.sourceTraceId);
  }
  return [...ids];
}

export interface ExportResult {
  bundle: TraceBundle;
  path: string;
  exported: number;
  /** Ids the suite references that the store does not have. */
  missing: string[];
  bytes: number;
}

export async function exportSuiteTraces(options: {
  suite: SuiteFile;
  store: TraceStore;
  path: string;
  now?: number;
  cwd?: string;
}): Promise<ExportResult> {
  const traces: Trace[] = [];
  const missing: string[] = [];

  for (const id of requiredTraceIds(options.suite)) {
    const trace = await options.store.get(id);
    if (trace) traces.push(trace);
    else missing.push(id);
  }

  const bundle: TraceBundle = {
    version: BUNDLE_VERSION,
    suite: options.suite.name,
    commit: await currentCommit(options.cwd),
    createdAt: options.now ?? Date.now(),
    traces,
  };

  const body = `${JSON.stringify(bundle, null, 2)}\n`;
  await mkdir(dirname(options.path), { recursive: true });
  await writeFile(options.path, body, "utf8");

  return { bundle, path: options.path, exported: traces.length, missing, bytes: body.length };
}

export class IncompatibleBundleError extends Error {
  constructor(found: unknown) {
    super(
      `Trace bundle is version ${String(found)}, this build reads version ${BUNDLE_VERSION}. ` +
        "Re-export it with a matching version of the tool.",
    );
    this.name = "IncompatibleBundleError";
  }
}

export interface ImportResult {
  imported: number;
  /** Traces already present, which are content-addressed and so identical. */
  skipped: number;
  commit: string | null;
}

export async function importTraceBundle(options: {
  store: TraceStore;
  path: string;
}): Promise<ImportResult> {
  if (!existsSync(options.path)) {
    throw new Error(`No trace bundle at ${options.path}.`);
  }

  const bundle = JSON.parse(await readFile(options.path, "utf8")) as TraceBundle;
  if (bundle.version !== BUNDLE_VERSION) throw new IncompatibleBundleError(bundle.version);

  let imported = 0;
  let skipped = 0;

  for (const trace of bundle.traces) {
    const existing = await options.store.get(trace.id);
    if (existing) {
      skipped += 1;
      continue;
    }
    await options.store.put(trace);
    imported += 1;
  }

  return { imported, skipped, commit: bundle.commit };
}

/** Whether a suite can run here, and what is missing if not. */
export async function checkSuiteRunnable(
  suite: SuiteFile,
  store: TraceStore,
): Promise<{ runnable: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const id of requiredTraceIds(suite)) {
    if (!(await store.get(id))) missing.push(id);
  }
  return { runnable: missing.length === 0, missing };
}
