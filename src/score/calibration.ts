/**
 * Tier 3 — measuring the judge against the humans.
 *
 * The judge runs over every labelled pair and its verdicts are compared with
 * the human's. The output is Cohen's kappa, which rides on every judged verdict
 * as `trust` and decides whether the report presents those verdicts as fact or
 * flags them.
 *
 * This runs out of band, not in the scoring path. It is a periodic audit of the
 * instrument, and its cost is paid once per judge change rather than once per
 * case.
 */

import { cohensKappa, type KappaResult } from "./kappa.ts";
import type { Judge, Winner } from "./judge.ts";
import type { LabelItem, LabelSet, StoredCalibration } from "./labels.ts";
import { labelledItems } from "./labels.ts";

export interface CalibrationOptions {
  set: LabelSet;
  judge: Judge;
  judgeModel: string;
  judgePromptVersion?: string;
  /**
   * Also run every item in both presentation orders to measure position bias
   * directly. Doubles the cost, so it is opt-in.
   */
  measurePositionBias?: boolean;
  /**
   * The reference the human had. Every label in this project was made with the
   * answer key open, so measuring a judge that has never seen it compares two
   * different jobs and blames the judge for the difference (see rubrics.ts).
   */
  rubrics?: ReadonlyMap<string, string>;
  onProgress?: (done: number, total: number) => void;
  now?: number;
}

export interface CalibrationResult {
  kappa: KappaResult;
  pairs: { item: LabelItem; human: Winner; judge: Winner; agreed: boolean }[];
  unparsed: number;
  positionFlips: number | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  stored: StoredCalibration;
}

export class NotEnoughLabelsError extends Error {
  constructor(n: number, needed: number) {
    super(
      `Only ${n} labelled pairs; kappa on fewer than ${needed} is too noisy to act on. ` +
        "Label more with `fr label`.",
    );
    this.name = "NotEnoughLabelsError";
  }
}

/** Below this, kappa's interval is so wide the number means nothing. */
export const MIN_LABELS = 30;

export async function calibrate(options: CalibrationOptions): Promise<CalibrationResult> {
  const labelled = labelledItems(options.set);
  if (labelled.length < MIN_LABELS) {
    throw new NotEnoughLabelsError(labelled.length, MIN_LABELS);
  }

  const pairs: CalibrationResult["pairs"] = [];
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let unparsed = 0;
  let positionFlips = 0;

  for (const [index, item] of labelled.entries()) {
    const judgeItem = {
      id: item.id,
      task: item.task,
      baseline: item.baseline,
      candidate: item.candidate,
      rubric: options.rubrics?.get(item.task) ?? null,
    };

    let verdict;
    if (options.measurePositionBias) {
      const both = await options.judge.measurePositionBias(judgeItem);
      if (both.flipped) positionFlips += 1;
      verdict = both.verdicts[0]!;
      for (const v of both.verdicts) {
        usage.inputTokens += v.usage.inputTokens;
        usage.outputTokens += v.usage.outputTokens;
        usage.costUsd += v.usage.costUsd;
        if (v.unparsed) unparsed += 1;
      }
    } else {
      verdict = await options.judge.judge(judgeItem);
      usage.inputTokens += verdict.usage.inputTokens;
      usage.outputTokens += verdict.usage.outputTokens;
      usage.costUsd += verdict.usage.costUsd;
      if (verdict.unparsed) unparsed += 1;
    }

    pairs.push({
      item,
      human: item.human!,
      judge: verdict.winner,
      agreed: item.human === verdict.winner,
    });

    options.onProgress?.(index + 1, labelled.length);
  }

  const kappa = cohensKappa(
    pairs.map((pair) => ({ human: pair.human, judge: pair.judge })),
    options.set.name,
  );

  const createdAt = options.now ?? Date.now();
  const stored: StoredCalibration = {
    labelSet: options.set.name,
    judgeModel: options.judgeModel,
    judgePromptVersion: options.judgePromptVersion ?? "unknown",
    rubricPairs: pairs.filter(({ item }) => options.rubrics?.has(item.task)).length,
    n: pairs.length,
    kappa: kappa.kappa,
    kappaLower: kappa.interval.lower,
    kappaUpper: kappa.interval.upper,
    observedAgreement: kappa.observedAgreement,
    unparsedRate: unparsed / Math.max(1, pairs.length),
    positionFlipRate: options.measurePositionBias ? positionFlips / pairs.length : null,
    judgeInputTokens: usage.inputTokens,
    judgeOutputTokens: usage.outputTokens,
    judgeCostUsd: usage.costUsd,
    createdAt,
  };

  return {
    kappa,
    pairs,
    unparsed,
    positionFlips: options.measurePositionBias ? positionFlips : null,
    usage,
    stored,
  };
}
