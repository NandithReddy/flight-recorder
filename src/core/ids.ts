import { createHash, randomUUID } from "node:crypto";
import type { RunConfig } from "./types.ts";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic JSON. Object keys are emitted in sorted order so that two
 * structurally equal values always hash to the same digest — content
 * addressing and config pinning both depend on this.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(",")}}`;
}

/**
 * A config's identity is the hash of the fields that can change the answer.
 * Two runs with the same configId are directly comparable; two runs without
 * are not, and the report refuses to pretend otherwise.
 */
export function configId(config: Omit<RunConfig, "id">): string {
  return `cfg_${sha256(stableStringify(config)).slice(0, 16)}`;
}

export function makeConfig(config: Omit<RunConfig, "id">): RunConfig {
  return { ...config, id: configId(config) };
}
