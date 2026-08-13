/**
 * Filesystem trace store: a JSON index plus content-addressed blobs.
 *
 * Phase 2 replaces the index with SQLite and adds payload-level deduplication
 * (agent traces repeat the same system prompt thousands of times). The blob
 * layout below is already the one SQLite will point at, so that migration
 * touches the index only.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256, stableStringify } from "../core/ids.ts";
import type { Trace, TraceSummary } from "../core/types.ts";
import type { TraceStore } from "./types.ts";

export const DEFAULT_ROOT = ".flightrecorder";

function summarise(trace: Trace, sha: string): TraceSummary {
  return {
    id: trace.id,
    sha,
    agent: trace.agent,
    configId: trace.config.id,
    model: trace.config.model,
    startedAt: trace.startedAt,
    totals: trace.totals,
    ok: trace.error === null,
    replayOf: trace.replayOf,
    tags: trace.tags,
  };
}

export class FsTraceStore implements TraceStore {
  #root: string;

  constructor(root: string = DEFAULT_ROOT) {
    this.#root = root;
  }

  get root(): string {
    return this.#root;
  }

  #indexPath(): string {
    return join(this.#root, "index.json");
  }

  #blobPath(sha: string): string {
    return join(this.#root, "blobs", sha.slice(0, 2), `${sha}.json`);
  }

  async #readIndex(): Promise<TraceSummary[]> {
    const path = this.#indexPath();
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(await readFile(path, "utf8")) as TraceSummary[];
    } catch {
      // A torn index must never lose the blobs; surface it loudly instead.
      throw new Error(
        `Trace index at ${path} is unreadable. The blobs are intact — ` +
          `delete the index to rebuild it.`,
      );
    }
  }

  async #writeIndex(entries: TraceSummary[]): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const tmp = `${this.#indexPath()}.tmp`;
    await writeFile(tmp, JSON.stringify(entries, null, 2), "utf8");
    // Atomic swap, so a crash mid-write cannot corrupt the index.
    await writeFile(this.#indexPath(), await readFile(tmp, "utf8"), "utf8");
    await writeFile(tmp, "", "utf8");
  }

  async put(trace: Trace): Promise<{ id: string; sha: string; deduped: boolean }> {
    const body = stableStringify(trace);
    const sha = sha256(body);
    const path = this.#blobPath(sha);

    const deduped = existsSync(path);
    if (!deduped) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body, "utf8");
    }

    const index = await this.#readIndex();
    const next = index.filter((entry) => entry.id !== trace.id);
    next.push(summarise(trace, sha));
    next.sort((a, b) => b.startedAt - a.startedAt);
    await this.#writeIndex(next);

    return { id: trace.id, sha, deduped };
  }

  async get(id: string): Promise<Trace | null> {
    const entry = (await this.#readIndex()).find((e) => e.id === id);
    if (!entry) return null;
    const path = this.#blobPath(entry.sha);
    if (!existsSync(path)) {
      throw new Error(`Index references blob ${entry.sha} which is missing from ${path}`);
    }
    return JSON.parse(await readFile(path, "utf8")) as Trace;
  }

  async list(options: { limit?: number; agent?: string } = {}): Promise<TraceSummary[]> {
    let entries = await this.#readIndex();
    if (options.agent) entries = entries.filter((e) => e.agent.name === options.agent);
    return options.limit ? entries.slice(0, options.limit) : entries;
  }

  async stats(): Promise<{ traces: number; blobs: number; bytes: number }> {
    const traces = (await this.#readIndex()).length;
    const blobRoot = join(this.#root, "blobs");
    if (!existsSync(blobRoot)) return { traces, blobs: 0, bytes: 0 };

    let blobs = 0;
    let bytes = 0;
    for (const prefix of await readdir(blobRoot)) {
      const dir = join(blobRoot, prefix);
      for (const file of await readdir(dir)) {
        blobs += 1;
        bytes += (await stat(join(dir, file))).size;
      }
    }
    return { traces, blobs, bytes };
  }
}
