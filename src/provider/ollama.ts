/**
 * Provider adapter: Ollama, running locally.
 *
 * Free, unmetered, and no key — which makes it the default subject for
 * developing and dogfooding the harness. For a regression harness the subject
 * model's intelligence matters much less than people assume: what the fixtures
 * need is runs that call tools and can plausibly get worse, not frontier
 * reasoning. An 8B model regresses just as legibly as a frontier one.
 *
 * It also gives the config matrix a second real axis. Comparing a local model
 * against a hosted one moves quality, cost and latency all at once, which is
 * exactly the three-way tradeoff the report exists to make visible.
 *
 * This talks to Ollama's native /api/chat rather than its OpenAI-compatible
 * endpoint: the native shape reports true prompt/eval token counts, and writing
 * a second adapter against a genuinely different wire format is what proves the
 * ModelClient seam is real rather than an OpenAI schema in disguise.
 */

import type {
  FinishReason,
  GenerateRequest,
  GenerateResponse,
  Message,
  ModelClient,
  ToolCall,
  ToolSpec,
} from "./types.ts";

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

export interface OllamaClientOptions {
  host?: string;
  /** Per-call timeout. Local models are slow; default 300s. */
  timeoutMs?: number;
}

export class OllamaUnavailableError extends Error {
  constructor(host: string, cause?: unknown) {
    super(
      `No Ollama daemon at ${host}. Start one with \`ollama serve\`, or install it ` +
        `with \`brew install ollama\`.` +
        (cause instanceof Error ? ` (${cause.message})` : ""),
    );
    this.name = "OllamaUnavailableError";
  }
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
  id?: string;
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

export async function isOllamaRunning(host: string = DEFAULT_OLLAMA_HOST): Promise<boolean> {
  try {
    const response = await fetch(`${host}/api/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function listOllamaModels(host: string = DEFAULT_OLLAMA_HOST): Promise<string[]> {
  const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new OllamaUnavailableError(host);
  const body = (await response.json()) as { models?: { name: string }[] };
  return (body.models ?? []).map((model) => model.name).sort();
}

function toOllamaMessages(messages: Message[]): OllamaMessage[] {
  return messages.map((message): OllamaMessage => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: call.input },
        })),
      };
    }

    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        ...(message.toolName ? { tool_name: message.toolName } : {}),
      };
    }

    return { role: message.role, content: message.content };
  });
}

function toOllamaTools(specs: ToolSpec[] | undefined) {
  if (!specs || specs.length === 0) return undefined;
  return specs.map((spec) => ({
    type: "function" as const,
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
    },
  }));
}

/**
 * Ollama does not always return an id for a tool call, and replay needs one
 * that is stable: stubbed mode matches a recorded tool response to a call by
 * id, so a random id would fail to match on the second run. Deriving it from
 * the position and name keeps it reproducible.
 */
function toolCallId(call: OllamaToolCall, index: number): string {
  return call.id ?? `call_${call.function.name}_${index}`;
}

function toFinishReason(response: OllamaChatResponse, toolCallCount: number): FinishReason {
  if (toolCallCount > 0) return "tool_use";
  if (response.done_reason === "length") return "length";
  return "stop";
}

export function createOllamaClient(options: OllamaClientOptions = {}): ModelClient {
  const host = options.host ?? DEFAULT_OLLAMA_HOST;
  const timeoutMs = options.timeoutMs ?? 300_000;

  return {
    providerId: "ollama",

    async generate(request: GenerateRequest): Promise<GenerateResponse> {
      let response: Response;
      try {
        response = await fetch(`${host}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: request.model,
            messages: toOllamaMessages(request.messages),
            tools: toOllamaTools(request.tools),
            stream: false,
            options: {
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
              ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
              ...(request.seed !== undefined ? { seed: request.seed } : {}),
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new OllamaUnavailableError(host, error);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Ollama returned ${response.status} for model "${request.model}"` +
            (detail ? `: ${detail.slice(0, 300)}` : ""),
        );
      }

      const body = (await response.json()) as OllamaChatResponse;

      const toolCalls: ToolCall[] = (body.message.tool_calls ?? []).map((call, index) => ({
        id: toolCallId(call, index),
        name: call.function.name,
        input: call.function.arguments ?? {},
      }));

      return {
        text: body.message.content ?? "",
        toolCalls,
        usage: {
          inputTokens: body.prompt_eval_count ?? 0,
          outputTokens: body.eval_count ?? 0,
          // Local inference is unmetered. Not free — it costs wall time and
          // electricity — but there is no per-token price to report, and
          // reporting a fabricated one would be worse than reporting zero.
          costUsd: 0,
          costUnknown: false,
        },
        finishReason: toFinishReason(body, toolCalls.length),
      };
    },
  };
}
