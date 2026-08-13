/**
 * Provider adapter: AI SDK through the Vercel AI Gateway.
 *
 * The harness's product is the configuration matrix, so the adapter that makes
 * varying `provider/model` across vendors free is worth more here than one
 * bound to a single vendor. One key, many providers, and a matrix entry for
 * `openai/...` costs the same to add as one for `anthropic/...`.
 *
 * Deliberately single-step: tools are declared without an `execute`, so the
 * model returns its tool calls rather than running them. The agent loop stays
 * ours, which is what lets the recorder put a span around every individual
 * model call and every individual tool call. Handing the loop to the SDK would
 * collapse the run into one opaque span and make replay impossible.
 */

import { generateText, jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";

import { costOf } from "./pricing.ts";
import type {
  FinishReason,
  GenerateRequest,
  GenerateResponse,
  Message,
  ModelClient,
  ToolCall,
  ToolSpec,
} from "./types.ts";

export interface GatewayClientOptions {
  /**
   * Overrides the resolved credential. Normally left unset — the AI SDK reads
   * AI_GATEWAY_API_KEY, or a Vercel OIDC token when deployed.
   */
  apiKey?: string;
  /** Per-call timeout. Default 120s. */
  timeoutMs?: number;
}

export class MissingGatewayCredentialError extends Error {
  constructor() {
    super(
      "No AI Gateway credential found. Set AI_GATEWAY_API_KEY in your environment " +
        "(https://vercel.com/ai-gateway), or run inside a Vercel deployment where " +
        "VERCEL_OIDC_TOKEN is provided.",
    );
    this.name = "MissingGatewayCredentialError";
  }
}

export function hasGatewayCredential(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN);
}

function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };

      case "user":
        return { role: "user", content: message.content };

      case "assistant": {
        if (!message.toolCalls || message.toolCalls.length === 0) {
          return { role: "assistant", content: message.content };
        }
        return {
          role: "assistant",
          content: [
            ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
            ...message.toolCalls.map((call) => ({
              type: "tool-call" as const,
              toolCallId: call.id,
              toolName: call.name,
              input: call.input,
            })),
          ],
        };
      }

      case "tool":
        return {
          role: "tool",
          content: [
            {
              type: "tool-result" as const,
              toolCallId: message.toolCallId ?? "",
              toolName: message.toolName ?? "",
              output: { type: "text" as const, value: message.content },
            },
          ],
        };
    }
  });
}

function toToolSet(specs: ToolSpec[] | undefined): ToolSet | undefined {
  if (!specs || specs.length === 0) return undefined;
  return Object.fromEntries(
    specs.map((spec) => [
      spec.name,
      // No `execute`: the model returns the call and our loop runs it.
      tool({ description: spec.description, inputSchema: jsonSchema(spec.inputSchema) }),
    ]),
  );
}

function toFinishReason(reason: string, toolCallCount: number): FinishReason {
  if (reason === "tool-calls" || toolCallCount > 0) return "tool_use";
  if (reason === "length") return "length";
  return "stop";
}

export function createGatewayClient(options: GatewayClientOptions = {}): ModelClient {
  const timeoutMs = options.timeoutMs ?? 120_000;

  return {
    providerId: "ai-gateway",

    async generate(request: GenerateRequest): Promise<GenerateResponse> {
      if (!options.apiKey && !hasGatewayCredential()) {
        throw new MissingGatewayCredentialError();
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const result = await generateText({
          // A plain "provider/model" string routes through the gateway.
          model: request.model,
          messages: toModelMessages(request.messages),
          tools: toToolSet(request.tools),
          temperature: request.temperature,
          maxOutputTokens: request.maxTokens,
          abortSignal: controller.signal,
          ...(options.apiKey ? { headers: { Authorization: `Bearer ${options.apiKey}` } } : {}),
        });

        const toolCalls: ToolCall[] = result.toolCalls.map((call) => ({
          id: call.toolCallId,
          name: call.toolName,
          input: (call.input ?? {}) as Record<string, unknown>,
        }));

        const usage = result.usage;
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
        const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;

        // Whether `inputTokens` already includes the cached portion varies by
        // provider, so prefer the SDK's explicit non-cached count and only fall
        // back to subtracting. Getting this wrong double-charges every cached
        // token, which on a long agent run is most of the bill.
        const billableInput =
          usage.inputTokenDetails.noCacheTokens ??
          Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);

        const { costUsd, unknown } = costOf({
          model: request.model,
          inputTokens: billableInput,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        });

        return {
          text: result.text,
          toolCalls,
          usage: {
            inputTokens,
            outputTokens,
            costUsd,
            cacheReadTokens,
            cacheWriteTokens,
            costUnknown: unknown,
          },
          finishReason: toFinishReason(result.finishReason, toolCalls.length),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
