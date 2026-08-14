/**
 * LangChain bridge — lets a foreign agent run on this harness's ModelClient.
 *
 * The point of phase 7 is testing an agent this project did not write. The
 * agent loop belongs to LangGraph; what the harness needs is for that loop's
 * model calls to flow through the recorder-wrapped `ModelClient` it already
 * knows how to instrument. This class is that seam: a `BaseChatModel` whose
 * `_generate` delegates to a `ModelClient`, so every call the foreign loop
 * makes lands in the trace as a model span with real usage — no HTTP proxy, no
 * patching of LangChain internals.
 *
 * Version notes that matter (written against the installed @langchain/core
 * 1.2.7, not from memory):
 *
 *   - `Runnable.bind()` is gone; binding happens through `withConfig`.
 *   - `bindTools` has no default implementation, and bound tools do NOT reach
 *     `_generate` automatically — they ride on a caller-declared field of the
 *     CallOptions generic, which survives the config split because it is not a
 *     RunnableConfig key.
 *   - `AIMessage.tool_calls[].args` is a parsed object, not a JSON string.
 */

import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatResult } from "@langchain/core/outputs";
import type {
  BaseLanguageModelInput,
  ToolDefinition,
} from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

import type {
  GenerateRequest,
  Message,
  ModelClient,
  ToolSpec,
} from "./types.ts";

/**
 * `tools` is our own addition. It is not a RunnableConfig key, so
 * `withConfig({tools})` carries it through the split and it arrives in
 * `_generate` as `options.tools` — the documented pattern for custom models in
 * core 1.x.
 */
export interface BridgeCallOptions extends BaseChatModelCallOptions {
  tools?: ToolDefinition[];
}

export interface BridgeOptions {
  /** Usually the recorder-wrapped client from `AgentContext`. */
  client: ModelClient;
  model: string;
  temperature?: number;
}

/** LangChain message → the harness's wire shape. */
export function toBridgeMessage(message: BaseMessage): Message {
  const content = message.text;

  switch (message.type) {
    case "system":
      return { role: "system", content };
    case "human":
      return { role: "user", content };
    case "ai": {
      const toolCalls = (message as AIMessage).tool_calls ?? [];
      return {
        role: "assistant",
        content,
        toolCalls: toolCalls.map((call, index) => ({
          // LangChain ids are optional; the harness's are not. The id pairs
          // a tool result to its call in LangGraph's ToolNode and in the
          // trace (the stub matches by tool name + input, not id), so a
          // missing id gets a deterministic one, as the Ollama adapter does.
          id: call.id ?? `call_${call.name}_${index}`,
          name: call.name,
          input: call.args,
        })),
      };
    }
    case "tool": {
      const tool = message as BaseMessage & { tool_call_id: string; name?: string };
      return {
        role: "tool",
        content,
        toolCallId: tool.tool_call_id,
        ...(tool.name ? { toolName: tool.name } : {}),
      };
    }
    default:
      throw new Error(
        `The bridge cannot convert a "${message.type}" message. If a LangChain ` +
          "agent starts emitting these, the conversion needs a real decision, " +
          "not a silent drop.",
      );
  }
}

/** OpenAI-style tool definition → the harness's ToolSpec. */
export function toToolSpec(definition: ToolDefinition): ToolSpec {
  return {
    name: definition.function.name,
    description: definition.function.description ?? "",
    inputSchema: (definition.function.parameters ?? {}) as Record<string, unknown>,
  };
}

export class ModelClientChatBridge extends BaseChatModel<BridgeCallOptions> {
  #client: ModelClient;
  #model: string;
  #temperature: number | undefined;

  constructor(options: BridgeOptions, params: BaseChatModelParams = {}) {
    super(params);
    this.#client = options.client;
    this.#model = options.model;
    this.#temperature = options.temperature;
  }

  _llmType(): string {
    return "flight-recorder-bridge";
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<BridgeCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, BridgeCallOptions> {
    return this.withConfig({
      tools: tools.map((tool) => convertToOpenAITool(tool)),
      ...kwargs,
    } as Partial<BridgeCallOptions>);
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const request: GenerateRequest = {
      model: this.#model,
      messages: messages.map(toBridgeMessage),
      ...(options.tools && options.tools.length > 0
        ? { tools: options.tools.map(toToolSpec) }
        : {}),
      ...(this.#temperature !== undefined ? { temperature: this.#temperature } : {}),
    };

    const response = await this.#client.generate(request);

    const message = new AIMessage({
      content: response.text,
      tool_calls: response.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.input,
      })),
    });

    return {
      generations: [{ text: response.text, message }],
      // Informational for LangChain callbacks. The trace's usage numbers come
      // from the recorder wrapping the client underneath, not from here.
      llmOutput: { usage: response.usage },
    };
  }
}
