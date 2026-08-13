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

/**
 * A small metrics warehouse.
 *
 * Deliberately more than one row. A single question produced a single
 * comparison, and a judge calibrated on one comparison is calibrated on
 * nothing — tier 3 needs a set of tasks with real variety in them.
 *
 * Every figure here is fictional and internally consistent, so a correct answer
 * is always derivable and a wrong one is always detectably wrong.
 */
const KNOWLEDGE_BASE: Record<string, string> = {
  "quarterly active users":
    "Q3 monthly active users: 1,200,000. Q4 monthly active users: 1,420,000.",
  "annual recurring revenue":
    "ARR at end of FY24: $48,200,000. ARR at end of FY23: $31,500,000.",
  "customer churn":
    "Customers at start of Q4: 8,400. Customers lost during Q4: 336.",
  "support ticket volume":
    "Tickets opened in November: 14,250. Tickets opened in October: 12,500.",
  "gross margin":
    "FY24 revenue: $48,200,000. FY24 cost of revenue: $11,568,000.",
  "trial conversion":
    "Trials started in Q4: 22,000. Trials converted to paid in Q4: 3,740.",
  "headcount growth":
    "Engineering headcount January: 145. Engineering headcount December: 203.",
  "infrastructure spend":
    "Cloud spend in Q3: $2,340,000. Cloud spend in Q4: $2,808,000.",
  "average deal size":
    "Total closed-won value in Q4: $9,600,000 across 320 deals.",
  "net revenue retention":
    "Starting ARR from existing customers: $31,500,000. Same-cohort ARR one year later: $37,170,000.",
  "page load latency":
    "p95 page load in January: 2,400ms. p95 page load in June: 1,680ms.",
  "mobile share":
    "Sessions in Q4: 45,000,000. Sessions from mobile devices in Q4: 29,250,000.",
  "enterprise pipeline":
    "Enterprise pipeline entering Q1: $18,400,000. Pipeline closed by end of Q1: $4,232,000.",
  "onboarding completion":
    "Accounts that began onboarding in Q4: 12,600. Accounts that finished onboarding: 9,072.",
  "api error rate":
    "API requests in December: 890,000,000. API requests returning 5xx in December: 1,335,000.",
  "seat expansion":
    "Seats sold to existing accounts in FY23: 41,000. Seats sold to existing accounts in FY24: 56,580.",
  "marketing spend efficiency":
    "Marketing spend in Q4: $6,200,000. New ARR attributed to marketing in Q4: $9,920,000.",
  "storage footprint":
    "Stored data at end of Q3: 840 TB. Stored data at end of Q4: 1,050 TB.",
  "on call load":
    "Pages received in Q3: 412. Pages received in Q4: 289.",
  "documentation coverage":
    "Public API endpoints: 640. Endpoints with reference documentation: 512.",
  "renewal rate":
    "Contracts up for renewal in FY24: 2,850. Contracts renewed in FY24: 2,536.",
  "test suite duration":
    "CI suite duration in March: 47 minutes. CI suite duration in September: 28 minutes.",
  "partner sourced revenue":
    "Total new ARR in FY24: $16,700,000. New ARR sourced by partners in FY24: $3,507,000.",
  "free tier usage":
    "Registered accounts: 384,000. Accounts on the free tier: 322,560.",
  "incident recovery":
    "Mean time to recovery in H1: 96 minutes. Mean time to recovery in H2: 54 minutes.",
  "sales cycle length":
    "Average days from first contact to close in FY23: 84. Average in FY24: 63.",
  "support satisfaction":
    "Support conversations rated in Q4: 7,400. Conversations rated positive: 6,586.",
  "database growth":
    "Primary database size in January: 3.2 TB. Primary database size in December: 5.44 TB.",
  "feature adoption":
    "Accounts with access to the new workspace feature: 24,000. Accounts that used it at least once: 8,640.",
  "contractor ratio":
    "Total engineering staff: 203. Engineering staff on contract: 41.",
};

/**
 * The task set the harness exercises.
 *
 * Each is answerable from one lookup plus one calculation, which keeps the
 * agent's job small and the grading unambiguous — the interesting variance is
 * in whether a model looks anything up at all, not in task difficulty.
 */
export const TASKS: string[] = [
  "How much did active users grow last quarter, in percent?",
  "What was the year-over-year ARR growth rate, in percent?",
  "What was the customer churn rate in Q4, in percent?",
  "By what percentage did support ticket volume change from October to November?",
  "What was the FY24 gross margin, in percent?",
  "What was the trial-to-paid conversion rate in Q4, in percent?",
  "By what percentage did engineering headcount grow over the year?",
  "How much did infrastructure spend increase last quarter, in percent?",
  "What was the average deal size in Q4?",
  "What was net revenue retention over the year, in percent?",
  "By what percentage did p95 page load latency improve between January and June?",
  "What share of Q4 sessions came from mobile, in percent?",
  "What percentage of the enterprise pipeline closed in Q1?",
  "What was the onboarding completion rate in Q4, in percent?",
  "What was the API 5xx error rate in December, in percent?",
  "By what percentage did seat expansion grow from FY23 to FY24?",
  "What was the return on marketing spend in Q4, as a ratio?",
  "By what percentage did the storage footprint grow last quarter?",
  "By what percentage did on-call page volume fall from Q3 to Q4?",
  "What share of public API endpoints have reference documentation, in percent?",
  "What was the contract renewal rate in FY24, in percent?",
  "By what percentage did the CI suite get faster between March and September?",
  "What share of FY24 new ARR was sourced by partners, in percent?",
  "What percentage of registered accounts are on the free tier?",
  "By what percentage did mean time to recovery improve from H1 to H2?",
  "By what percentage did the sales cycle shorten from FY23 to FY24?",
  "What was the support satisfaction rate in Q4, in percent?",
  "By what percentage did the primary database grow over the year?",
  "What was the adoption rate of the new workspace feature, in percent?",
  "What share of engineering staff are contractors, in percent?",
];

/**
 * Keyword-overlap lookup rather than an exact key match.
 *
 * The exact match was fine against a scripted mock, which always sent the same
 * string. A real model phrases the query however it likes — "active user
 * growth", "MAU last quarter" — and an exact match returns nothing, so the
 * agent gets no data and the run fails for reasons that have nothing to do with
 * the model's ability. A fixture that only works with one phrasing is testing
 * the fixture.
 */
function search(input: { query: string }): string {
  const words = new Set(
    input.query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );

  let best: { entry: string; score: number } | null = null;
  for (const [key, entry] of Object.entries(KNOWLEDGE_BASE)) {
    const keyWords = key.split(" ");
    const score = keyWords.filter((word) => words.has(word)).length / keyWords.length;
    if (score >= 0.5 && (best === null || score > best.score)) best = { entry, score };
  }

  return best ? best.entry : "No matching records found.";
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

/**
 * Written against a real model, not a scripted one.
 *
 * The first version — "verify every number with a tool" — was enough for the
 * mock, which followed a script. A real 3B model read it and called `calculate`
 * with `(100 * (active_users_last_quarter - ...))`: variable names it had
 * invented, for values it had never looked up. The prompt never said where
 * numbers come from or that expressions must contain literals.
 *
 * This is the version a careful engineer writes after seeing that trace. It is
 * deliberately not tuned for any one model — which model can follow it is a
 * result the matrix should report, not something to prompt around.
 */
const PROMPT_V1 = [
  "You are a metrics analyst.",
  "",
  "Workflow, in order:",
  "1. Call `search` to retrieve the figures you need. Never answer from memory.",
  "2. Call `calculate` to derive any percentage or change, passing an expression",
  "   built only from the literal numbers `search` returned. Expressions must",
  "   contain digits and operators only — never variable names or placeholders.",
  "3. State the answer, quoting the figures you retrieved.",
].join("\n");

/**
 * The prompt this project started with, kept as a variant to regress against.
 *
 * It is not a strawman — it is a perfectly reasonable first draft, and it is
 * what a real prompt looks like before someone has watched it fail. It never
 * says where numbers come from or that expressions must contain literals, and
 * that omission is exactly what a regression suite should be able to detect.
 */
const PROMPT_V0 = "You are a metrics analyst. Verify every number with a tool before reporting it.";

export const PROMPTS: Record<string, string> = { v1: PROMPT_V1, v0: PROMPT_V0 };

const MAX_STEPS = 8;

export const demoAgent: RecordableAgent<string, string> = {
  ref: { name: "metrics-analyst", version: "0.1.0" },

  async run(question: string, ctx: AgentContext): Promise<string> {
    const tools = {
      search: ctx.recorder.wrapTool("search", search),
      calculate: ctx.recorder.wrapTool("calculate", calculate),
    };

    const messages: Message[] = [
      { role: "system", content: PROMPTS[ctx.promptVersion] ?? PROMPT_V1 },
      { role: "user", content: question },
    ];

    for (let step = 0; step < MAX_STEPS; step += 1) {
      const response = await ctx.client.generate({
        model: ctx.model,
        messages,
        tools: TOOL_SPECS,
        temperature: 0,
      });

      // The assistant turn must carry its tool calls: a real provider rejects a
      // tool result whose originating call is missing from the turn before it.
      messages.push({
        role: "assistant",
        content: response.text,
        toolCalls: response.toolCalls,
      });

      if (response.finishReason !== "tool_use" || response.toolCalls.length === 0) {
        return response.text;
      }

      for (const call of response.toolCalls) {
        const tool = tools[call.name as keyof typeof tools];
        const content = tool
          ? await tool(call.input as never)
          : `No such tool: ${call.name}`;
        messages.push({
          role: "tool",
          content,
          toolCallId: call.id,
          toolName: call.name,
        });
      }
    }

    throw new Error(`Agent exceeded ${MAX_STEPS} steps without finishing`);
  },
};

export const DEMO_QUESTION =
  "How much did active users grow last quarter, in percent?";
