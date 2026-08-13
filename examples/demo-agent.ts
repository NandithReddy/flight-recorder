/**
 * A small multi-step tool-using agent, used as the harness's own test subject
 * during development.
 *
 * This is scaffolding, not the deliverable. Phase 7 points the harness at a
 * real open-source agent; this one exists so every earlier phase has something
 * deterministic and free to record, replay and diff against.
 */

import type { AgentContext, RecordableAgent } from "../src/replay/replay.ts";
import type { Message, ToolSpec } from "../src/provider/types.ts";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOL_SPECS: ToolSpec[] = [
  {
    name: "search",
    description: "Look up a metric in the company knowledge base.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "calculate",
    description: "Evaluate an arithmetic expression.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  },
];

const KNOWLEDGE_BASE: Record<string, string> = {
  "quarterly active users":
    "Q3 monthly active users: 1,200,000. Q4 monthly active users: 1,420,000.",
};

function search(input: { query: string }): string {
  return KNOWLEDGE_BASE[input.query.toLowerCase()] ?? "No matching records found.";
}

/**
 * A deliberately small recursive-descent arithmetic evaluator.
 * The agent under test must never hand model output to eval().
 */
function evaluateExpression(source: string): number {
  let pos = 0;

  const skipSpace = () => {
    while (pos < source.length && source[pos] === " ") pos += 1;
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    for (;;) {
      skipSpace();
      const op = source[pos];
      if (op !== "+" && op !== "-") return value;
      pos += 1;
      const right = parseTerm();
      value = op === "+" ? value + right : value - right;
    }
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    for (;;) {
      skipSpace();
      const op = source[pos];
      if (op !== "*" && op !== "/") return value;
      pos += 1;
      const right = parseFactor();
      if (op === "/" && right === 0) throw new Error("division by zero");
      value = op === "*" ? value * right : value / right;
    }
  };

  const parseFactor = (): number => {
    skipSpace();
    if (source[pos] === "(") {
      pos += 1;
      const value = parseExpression();
      skipSpace();
      if (source[pos] !== ")") throw new Error(`expected ')' at position ${pos}`);
      pos += 1;
      return value;
    }
    if (source[pos] === "-") {
      pos += 1;
      return -parseFactor();
    }
    const start = pos;
    while (pos < source.length && /[0-9._]/.test(source[pos] ?? "")) pos += 1;
    if (start === pos) throw new Error(`expected a number at position ${pos}`);
    const literal = source.slice(start, pos).replaceAll("_", "");
    const value = Number(literal);
    if (Number.isNaN(value)) throw new Error(`bad number literal '${literal}'`);
    return value;
  };

  const result = parseExpression();
  skipSpace();
  if (pos !== source.length) throw new Error(`unexpected input at position ${pos}`);
  return result;
}

function calculate(input: { expression: string }): string {
  return evaluateExpression(input.expression).toFixed(2);
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are a metrics analyst. Verify every number with a tool before reporting it.";

const MAX_STEPS = 8;

export const demoAgent: RecordableAgent<string, string> = {
  ref: { name: "metrics-analyst", version: "0.1.0" },

  async run(question: string, ctx: AgentContext): Promise<string> {
    const tools = {
      search: ctx.recorder.wrapTool("search", search),
      calculate: ctx.recorder.wrapTool("calculate", calculate),
    };

    const messages: Message[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: question },
    ];

    for (let step = 0; step < MAX_STEPS; step += 1) {
      const response = await ctx.client.generate({
        model: "demo-model",
        messages,
        tools: TOOL_SPECS,
        temperature: 0,
      });

      messages.push({ role: "assistant", content: response.text });

      if (response.finishReason !== "tool_use" || response.toolCalls.length === 0) {
        return response.text;
      }

      for (const call of response.toolCalls) {
        const tool = tools[call.name as keyof typeof tools];
        const content = tool
          ? await tool(call.input as never)
          : `No such tool: ${call.name}`;
        messages.push({ role: "tool", content, toolCallId: call.id });
      }
    }

    throw new Error(`Agent exceeded ${MAX_STEPS} steps without finishing`);
  },
};

export const DEMO_QUESTION =
  "How much did active users grow last quarter, in percent?";
