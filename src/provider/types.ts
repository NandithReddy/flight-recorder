/**
 * The provider-agnostic seam.
 *
 * Everything above this line (recorder, replayer, scorer) knows only these
 * types. Adding Anthropic, OpenAI or the Vercel AI Gateway later means writing
 * one adapter that satisfies `ModelClient` — nothing else changes.
 */

import type { RunError, Usage } from "../core/types.ts";

export type Role = "system" | "user" | "assistant" | "tool";

/**
 * Errors that mean "the harness could not run the agent" rather than "the agent
 * failed", identified by the `name` an adapter stamps on them — the only part of
 * an error that survives into a stored `RunError`.
 *
 * The distinction is the difference between a result and a non-result. A run
 * that died because the Ollama daemon was down is not evidence about a model,
 * but it was stored as an Attempt like any other, resumed forever after, and
 * counted in every rate computed since: 23 such runs sat in this project's own
 * metrics suite, scored as agent failures, until a comparison that depended on
 * them was checked line by line (D-046).
 */
export const ENVIRONMENT_ERROR_TYPES: readonly string[] = [
  "OllamaUnavailableError",
  "MissingGatewayCredentialError",
  "DockerUnavailableError",
];

/** True when a run failed for a reason that says nothing about the agent. */
export function isEnvironmentFailure(error: RunError | null | undefined): boolean {
  return error?.type !== undefined && ENVIRONMENT_ERROR_TYPES.includes(error.type);
}

/**
 * A turn in the conversation.
 *
 * `toolCalls` on an assistant turn is not optional bookkeeping — it is the link
 * between a call and its result. The phase-0 mock ignored history structure and
 * got away without it; a real provider rejects a tool result whose originating
 * call is missing from the assistant turn that precedes it.
 */
export interface Message {
  role: Role;
  content: string;
  /** `assistant` turns only: the calls this turn requested. */
  toolCalls?: ToolCall[];
  /** `tool` turns only: which call this result answers. */
  toolCallId?: string;
  /** `tool` turns only: the tool that produced it. */
  toolName?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface GenerateRequest {
  model: string;
  messages: Message[];
  tools?: ToolSpec[];
  temperature?: number;
  seed?: number;
  maxTokens?: number;
}

export type FinishReason = "stop" | "tool_use" | "length";

export interface GenerateResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: FinishReason;
}

export interface ModelClient {
  readonly providerId: string;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}
