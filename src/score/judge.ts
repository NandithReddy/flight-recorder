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

/**
 * v3, written against v2's confusion matrix — the same method that produced v2,
 * applied to what v2 actually did rather than to what v1 did.
 *
 * v2 fixed the thing it was written to fix: it says TIE 9 times where v1 said it
 * 0. The remaining error is concentrated in one cell. Of the 21 pairs a human
 * called equivalent, the judge called 11 of them wins for one side — half its
 * total disagreement sits there, and every one of those is the judge finding a
 * tiebreaker in wording after the figures already matched.
 *
 * So v3 stops asking for a comparison and asks for a procedure: extract each
 * answer's figure first, and let TIE fall out of the figures agreeing rather
 * than be a verdict the model has to talk itself into. Telling a model that
 * "TIE is a real verdict" is a hint. Telling it to compare two extracted values
 * is an instruction.
 */
const JUDGE_PROMPT_V3 = [
  "You are comparing two answers to the same task. Follow this procedure exactly.",
  "",
  "STEP 1. From each answer, extract the single figure it gives as its final",
  "answer to the task. If an answer gives no figure, or says it cannot find the",
  "data, record it as NONE.",
  "",
  "STEP 2. Compare the two extracted figures.",
  "  - Same figure (allowing for rounding and formatting — 18.33%, 18.3% and",
  '    "about 18.33 percent" are the same figure): the verdict is TIE. Stop.',
  "    Do not look for a tiebreaker in the wording, the detail, the explanation,",
  "    or the confidence. Two answers that reach the same figure are equally",
  "    correct, however differently they are written.",
  "  - Both NONE: the verdict is TIE. Stop.",
  "  - The figures differ: go to step 3.",
  "",
  "STEP 3. Decide which figure is right, using the RUBRIC if one is given.",
  "Without a rubric, judge which figure the answer actually establishes.",
  "  - A figure derived from numbers the answer invented is wrong, no matter how",
  "    correct the arithmetic over them is. Shown working is not evidence; it is",
  "    the cheapest thing to fabricate.",
  "  - NONE beats a wrong figure. An answer that says it could not find the data",
  "    is better than one that invents a plausible number.",
  "  - Length, detail and confidence are not evidence of anything.",
  "",
  'Reply with one line of JSON and nothing else: {"winner": "A"|"B"|"TIE", "reason": "<one sentence>"}',
].join("\n");

/**
 * v4 — v3's procedure, defended against the rubric.
 *
 * Giving v3 the answer key made it *worse*: kappa fell from 0.459 to 0.188. The
 * matrix says exactly what happened. On pairs that genuinely differ it became
 * near-perfect (22 of 23, against 11 of 23 blind) — the rubric works. But its
 * ties collapsed from 19 of 21 to 1 of 21: handed a reference, the model starts
 * grading each answer's *resemblance* to it, and the answer that also shows the
 * derivation wins over the one that just states the same correct figure.
 *
 * That is v2's "detail is quality" failure returning through a new door, and it
 * is invisible to a prompt that merely mentions the rubric late. v4 fences the
 * rubric off from the tie test explicitly, because the instruction that needs to
 * be hardest to skip is the one the model is most motivated to skip.
 */
const JUDGE_PROMPT_V4 = [
  "You are comparing two answers to the same task. Follow this procedure exactly,",
  "in order. Do not skip ahead.",
  "",
  "STEP 1. From each answer, extract the single figure it gives as its final",
  "answer to the task. If an answer gives no figure, or says it cannot find the",
  "data, record it as NONE. Ignore everything else in the answer.",
  "",
  "STEP 2. Compare ONLY those two extracted figures with each other.",
  "IGNORE THE RUBRIC ENTIRELY IN THIS STEP. It is not relevant yet.",
  "  - Same figure (allowing for rounding and formatting — 18.33%, 18.3% and",
  '    "about 18.33 percent" are the same figure): the verdict is TIE. Stop.',
  "  - Both NONE: the verdict is TIE. Stop.",
  "  - The figures differ: go to step 3.",
  "",
  "Two answers that reach the same figure are equally correct and the verdict is",
  "TIE, even when one of them shows its working, explains its derivation, matches",
  "the rubric's wording more closely, or is better written. None of that breaks a",
  "tie. If you have reached this line because both figures were the same, the",
  "answer is TIE and there is nothing further to weigh.",
  "",
  "STEP 3. Only now, and only because the figures differ: decide which figure is",
  "right. Use the RUBRIC as ground truth if one is given. Without a rubric, judge",
  "which figure the answer actually establishes.",
  "  - A figure derived from numbers the answer invented is wrong, however",
  "    correct the arithmetic over them is. Shown working is the cheapest thing",
  "    to fabricate.",
  "  - NONE beats a wrong figure: saying the data could not be found is better",
  "    than inventing a plausible number.",
  "",
  'Reply with one line of JSON and nothing else: {"winner": "A"|"B"|"TIE", "reason": "<one sentence>"}',
].join("\n");

export const JUDGE_PROMPTS: Record<string, string> = {
  v1: JUDGE_PROMPT_V1,
  v2: JUDGE_PROMPT_V2,
  v3: JUDGE_PROMPT_V3,
  v4: JUDGE_PROMPT_V4,
};

/**
 * v4, because it is the only version measured above the trust threshold
 * (kappa 0.687 against 47 human labels, with the answer key supplied). v1-v3 are
 * kept rather than deleted: an improvement nobody can re-measure is an
 * assertion, and the four together are the evidence.
 */
export const DEFAULT_JUDGE_PROMPT = "v4";

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
