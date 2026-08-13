/**
 * Tier 2 — the pairwise judge.
 *
 * Pairwise, not absolute. Asking a model "is this answer better than that one"
 * is dramatically more stable than asking it to score one answer out of ten,
 * and it maps directly onto the question a regression report actually asks:
 * did this change make things worse?
 *
 * Position bias is real and large — models favour whichever candidate they see
 * first, by enough to invent a winner on their own. So which answer is shown as
 * A is decided by a hash of the item id: unbiased across the set, and identical
 * every time the same item is judged, because a verdict that changes on re-run
 * is not a measurement.
 */

import { seedFrom } from "../stats/bootstrap.ts";
import type { ModelClient } from "../provider/types.ts";

export type Winner = "baseline" | "candidate" | "tie";

export interface JudgeItem {
  /** Stable identity — drives the presentation order. */
  id: string;
  task: string;
  baseline: string;
  candidate: string;
  rubric?: string | null;
}

export interface JudgeVerdict {
  winner: Winner;
  reason: string;
  /** Which slot the baseline occupied, for auditing. */
  baselineShownAs: "A" | "B";
  raw: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  /** Set when the judge's reply could not be parsed and a tie was assumed. */
  unparsed: boolean;
}

export interface Judge {
  judge(item: JudgeItem): Promise<JudgeVerdict>;
  /** Runs both presentation orders and reports whether the verdict flipped. */
  measurePositionBias(item: JudgeItem): Promise<{ flipped: boolean; verdicts: JudgeVerdict[] }>;
}

export interface JudgeOptions {
  client: ModelClient;
  model: string;
  /** Which prompt variant to judge with. Defaults to the current best. */
  promptVersion?: string;
  /** Extra instruction appended to every prompt. */
  guidance?: string;
  maxTokens?: number;
}

/**
 * The judge's own prompt is a config, and it is versioned for the same reason
 * the agent's is: it changes the answer, so it belongs in the matrix.
 *
 * v1 is kept rather than deleted. It scored kappa = -0.102 against 47 human
 * labels — significantly *worse* than chance — and keeping it is what makes the
 * improvement measurable instead of asserted.
 */
const JUDGE_PROMPT_V1 = [
  "You are grading two candidate answers to the same task.",
  "",
  "Judge only on whether the answer is correct, complete and supported by the",
  "work shown. Ignore length, tone, and formatting. An answer that states a",
  "figure it never established is worse than one that says it does not know.",
  "",
  'Reply with one line of JSON and nothing else: {"winner": "A"|"B"|"TIE", "reason": "<one sentence>"}',
].join("\n");

/**
 * v2, written against v1's confusion matrix rather than from intuition.
 *
 * Three things that matrix showed, each addressed explicitly below:
 *
 *   1. **It rewarded shown working.** v1 said "supported by the work shown",
 *      which a fabricated calculation satisfies perfectly. The judge preferred
 *      answers that invented figures and then showed arithmetic over them.
 *   2. **It never said TIE.** Zero times in 47, against a human who said it 21
 *      times. The option existed and the judge would not use it.
 *   3. **It read detail as quality.** Longer answers restating the figures won
 *      against correct one-liners.
 */
const JUDGE_PROMPT_V2 = [
  "You are comparing two answers to the same task. Decide which is better, or",
  "whether they are equally good.",
  "",
  "Judge correctness and nothing else. An answer is better when its figures are",
  "right.",
  "",
  "These are NOT evidence of quality:",
  "- Showing arithmetic. Working can be invented. A wrong figure with a",
  "  calculation attached is worse than a wrong figure without one, not better,",
  "  because it manufactures confidence it has not earned.",
  "- Length or detail. Restating the numbers does not make an answer more",
  "  correct.",
  "- Confidence. An answer that says it could not find the data is BETTER than",
  "  one that invents a plausible-looking number.",
  "",
  "TIE is a real verdict and frequently the right one. If both answers give the",
  "same figure, they are tied, however differently they are worded. Do not hunt",
  "for a tiebreaker.",
  "",
  'Reply with one line of JSON and nothing else: {"winner": "A"|"B"|"TIE", "reason": "<one sentence>"}',
].join("\n");

export const JUDGE_PROMPTS: Record<string, string> = {
  v1: JUDGE_PROMPT_V1,
  v2: JUDGE_PROMPT_V2,
};

export const DEFAULT_JUDGE_PROMPT = "v2";

function buildPrompt(item: JudgeItem, baselineShownAs: "A" | "B"): string {
  const a = baselineShownAs === "A" ? item.baseline : item.candidate;
  const b = baselineShownAs === "A" ? item.candidate : item.baseline;

  return [
    `TASK:\n${item.task}`,
    item.rubric ? `\nRUBRIC:\n${item.rubric}` : "",
    `\nANSWER A:\n${a}`,
    `\nANSWER B:\n${b}`,
    "\nWhich answer is better?",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Reads the judge's reply.
 *
 * Local models are unreliable JSON emitters, so this tries structured output
 * first and falls back to scanning for a verdict token. An unreadable reply
 * becomes a tie, flagged `unparsed` — guessing a winner from noise would put
 * fabricated signal into the report, and the calibration run needs to see how
 * often this happens.
 */
export function parseVerdict(raw: string): { winner: "A" | "B" | "TIE"; reason: string; unparsed: boolean } {
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { winner?: string; reason?: string };
      const winner = String(parsed.winner ?? "").trim().toUpperCase();
      if (winner === "A" || winner === "B" || winner === "TIE") {
        return { winner, reason: String(parsed.reason ?? "").slice(0, 300), unparsed: false };
      }
    } catch {
      // fall through to token scanning
    }
  }

  const token = raw.toUpperCase().match(/\b(ANSWER\s+)?(A|B|TIE)\b/);
  if (token?.[2] === "A" || token?.[2] === "B" || token?.[2] === "TIE") {
    return { winner: token[2], reason: raw.trim().slice(0, 300), unparsed: false };
  }

  return { winner: "TIE", reason: "judge reply could not be parsed", unparsed: true };
}

/** Which slot the baseline occupies — stable per item, balanced across items. */
export function baselineSlotFor(id: string): "A" | "B" {
  return seedFrom(id) % 2 === 0 ? "A" : "B";
}

export function createJudge(options: JudgeOptions): Judge {
  const promptVersion = options.promptVersion ?? DEFAULT_JUDGE_PROMPT;
  const system = JUDGE_PROMPTS[promptVersion];
  if (!system) {
    throw new Error(
      `No judge prompt "${promptVersion}". Known: ${Object.keys(JUDGE_PROMPTS).join(", ")}.`,
    );
  }

  const runOnce = async (item: JudgeItem, baselineShownAs: "A" | "B"): Promise<JudgeVerdict> => {
    const response = await options.client.generate({
      model: options.model,
      messages: [
        {
          role: "system",
          content: options.guidance ? `${system}\n\n${options.guidance}` : system,
        },
        { role: "user", content: buildPrompt(item, baselineShownAs) },
      ],
      temperature: 0,
      maxTokens: options.maxTokens ?? 200,
    });

    const parsed = parseVerdict(response.text);
    const winner: Winner =
      parsed.winner === "TIE"
        ? "tie"
        : (parsed.winner === "A") === (baselineShownAs === "A")
          ? "baseline"
          : "candidate";

    return {
      winner,
      reason: parsed.reason,
      baselineShownAs,
      raw: response.text,
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        costUsd: response.usage.costUsd,
      },
      unparsed: parsed.unparsed,
    };
  };

  return {
    judge: (item) => runOnce(item, baselineSlotFor(item.id)),

    measurePositionBias: async (item) => {
      const first = await runOnce(item, "A");
      const second = await runOnce(item, "B");
      return {
        // A judge with no position bias reaches the same verdict either way.
        flipped: first.winner !== second.winner,
        verdicts: [first, second],
      };
    },
  };
}
