/**
 * Cohen's kappa — how well the judge agrees with a human, correcting for luck.
 *
 * Raw agreement is a flattering and mostly meaningless number. If 80% of pairs
 * are ties and the judge always says "tie", it agrees 80% of the time while
 * knowing nothing. Kappa subtracts the agreement you would expect from two
 * raters guessing with the same marginal frequencies, so a judge that has
 * learned nothing scores about zero however lopsided the label distribution is.
 *
 * This number is the point of tier 3. Anyone can ship an LLM judge; publishing
 * how well it agrees with a person, and degrading the report when it does not,
 * is the part that makes the verdicts worth anything.
 */

import { bootstrap, type Interval } from "../stats/bootstrap.ts";

export interface RatedPair {
  human: string;
  judge: string;
}

export interface KappaResult {
  kappa: number;
  /** Observed agreement — the flattering number, reported for contrast. */
  observedAgreement: number;
  /** Agreement expected from the marginals alone. */
  expectedAgreement: number;
  n: number;
  /** Bootstrap interval on kappa itself. */
  interval: Interval;
  categories: string[];
  /** Confusion counts, `matrix[human][judge]`. */
  matrix: Record<string, Record<string, number>>;
}

export function cohensKappaValue(pairs: RatedPair[]): number {
  if (pairs.length === 0) return Number.NaN;

  const categories = [...new Set(pairs.flatMap((p) => [p.human, p.judge]))];
  const n = pairs.length;

  let agreed = 0;
  const humanCounts = new Map<string, number>();
  const judgeCounts = new Map<string, number>();

  for (const pair of pairs) {
    if (pair.human === pair.judge) agreed += 1;
    humanCounts.set(pair.human, (humanCounts.get(pair.human) ?? 0) + 1);
    judgeCounts.set(pair.judge, (judgeCounts.get(pair.judge) ?? 0) + 1);
  }

  const po = agreed / n;
  let pe = 0;
  for (const category of categories) {
    pe += ((humanCounts.get(category) ?? 0) / n) * ((judgeCounts.get(category) ?? 0) / n);
  }

  // Both raters used exactly one category and agreed throughout: chance already
  // explains everything, so kappa is undefined rather than perfect.
  if (pe === 1) return po === 1 ? Number.NaN : 0;
  return (po - pe) / (1 - pe);
}

export function cohensKappa(pairs: RatedPair[], seed = "kappa"): KappaResult {
  const categories = [...new Set(pairs.flatMap((p) => [p.human, p.judge]))].sort();

  const matrix: Record<string, Record<string, number>> = {};
  for (const human of categories) {
    matrix[human] = Object.fromEntries(categories.map((judge) => [judge, 0]));
  }
  for (const pair of pairs) {
    const row = matrix[pair.human];
    if (row) row[pair.judge] = (row[pair.judge] ?? 0) + 1;
  }

  const n = pairs.length;
  const agreed = pairs.filter((p) => p.human === p.judge).length;
  const kappa = cohensKappaValue(pairs);

  let pe = 0;
  for (const category of categories) {
    const humanShare = pairs.filter((p) => p.human === category).length / (n || 1);
    const judgeShare = pairs.filter((p) => p.judge === category).length / (n || 1);
    pe += humanShare * judgeShare;
  }

  return {
    kappa,
    observedAgreement: n === 0 ? Number.NaN : agreed / n,
    expectedAgreement: pe,
    n,
    interval: bootstrap(pairs, cohensKappaValue, { seed, iterations: 2000 }),
    categories,
    matrix,
  };
}

/**
 * Landis & Koch's bands, with the threshold this project actually gates on.
 *
 * 0.6 is the line: below it, judged verdicts are marked untrusted in the report
 * rather than presented as fact.
 */
export const TRUST_THRESHOLD = 0.6;

export function interpretKappa(kappa: number): string {
  if (Number.isNaN(kappa)) return "undefined";
  if (kappa < 0) return "worse than chance";
  if (kappa < 0.2) return "slight";
  if (kappa < 0.4) return "fair";
  if (kappa < 0.6) return "moderate";
  if (kappa < 0.8) return "substantial";
  return "almost perfect";
}

export function isTrustworthy(kappa: number): boolean {
  return !Number.isNaN(kappa) && kappa >= TRUST_THRESHOLD;
}

/** Renders the confusion matrix for the report. */
export function formatConfusion(result: KappaResult): string[] {
  const width = Math.max(8, ...result.categories.map((c) => c.length + 1));
  const header = ["human \\ judge".padEnd(16), ...result.categories.map((c) => c.padStart(width))];
  const rows = result.categories.map((human) =>
    [
      human.padEnd(16),
      ...result.categories.map((judge) =>
        String(result.matrix[human]?.[judge] ?? 0).padStart(width),
      ),
    ].join(""),
  );
  return [header.join(""), ...rows];
}
