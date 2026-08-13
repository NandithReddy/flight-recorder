/**
 * The provider-agnostic seam.
 *
 * Everything above this line (recorder, replayer, scorer) knows only these
 * types. Adding Anthropic, OpenAI or the Vercel AI Gateway later means writing
 * one adapter that satisfies `ModelClient` — nothing else changes.
 */

import type { Usage } from "../core/types.ts";

export type Role = "system" | "user" | "assistant" | "tool";

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
