/**
 * The provider-agnostic seam.
 *
 * Everything above this line (recorder, replayer, scorer) knows only these
 * types. Adding Anthropic, OpenAI or the Vercel AI Gateway later means writing
 * one adapter that satisfies `ModelClient` — nothing else changes.
 */

import type { Usage } from "../core/types.ts";

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  /** Set on `tool` messages to link the result back to its call. */
  toolCallId?: string;
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
