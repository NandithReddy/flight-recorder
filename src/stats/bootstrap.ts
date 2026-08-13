/**
 * Bootstrap resampling.
 *
 * Every headline number this project reports is an estimate from a small
 * sample, and a small-sample estimate without an interval is a claim dressed as
 * a measurement. Resampling gives an interval for any statistic without
 * assuming the sampling distribution has a convenient shape — which matters
 * here because pass rate is a proportion over ~50 cases and Cohen's kappa is a
 * ratio of proportions, and neither is well served by a normal approximation.
 *
 * The generator is seeded and deterministic on purpose. A confidence interval
 * that moves when you re-run the report is one nobody trusts, and reproducing
 * a published number six months later has to be possible.
 */

/** mulberry32 — small, fast, and good enough for resampling. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derives a stable numeric seed from any string, so runs are reproducible. */
export function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export interface Interval {
  point: number;
  lower: number;
  upper: number;
  /** True when the interval excludes zero. */
  significant: boolean;
  /** e.g. 0.95 */
  level: number;
  n: number;
  iterations: number;
}

export interface BootstrapOptions {
  iterations?: number;
  level?: number;
  seed?: number | string;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (index - lower) * (sorted[upper]! - sorted[lower]!);
}

/**
 * Percentile bootstrap for any statistic over a sample.
 *
 * `significant` means the interval excludes zero — the honest phrasing for a
 * *delta*. For a statistic that is not a difference, ignore it and read the
 * bounds.
 */
export function bootstrap<T>(
  sample: T[],
  statistic: (resample: T[]) => number,
  options: BootstrapOptions = {},
): Interval {
  const iterations = options.iterations ?? 10_000;
  const level = options.level ?? 0.95;
  const rng = seededRandom(
    typeof options.seed === "string" ? seedFrom(options.seed) : (options.seed ?? 1),
  );

  const point = statistic(sample);

  if (sample.length === 0) {
    return { point, lower: Number.NaN, upper: Number.NaN, significant: false, level, n: 0, iterations: 0 };
  }

  const draws: number[] = new Array<number>(iterations);
  const resample: T[] = new Array<T>(sample.length);

  for (let i = 0; i < iterations; i += 1) {
    for (let j = 0; j < sample.length; j += 1) {
      resample[j] = sample[Math.floor(rng() * sample.length)]!;
    }
    draws[i] = statistic(resample);
  }

  draws.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  const lower = percentile(draws, tail);
  const upper = percentile(draws, 1 - tail);

  return {
    point,
    lower,
    upper,
    significant: (lower > 0 && upper > 0) || (lower < 0 && upper < 0),
    level,
    n: sample.length,
    iterations,
  };
}

/** Formats an interval the way the report should read it out loud. */
export function describeInterval(interval: Interval, unit = ""): string {
  if (Number.isNaN(interval.lower)) return "no data";
  const fmt = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}${unit}`;
  const range = `${fmt(interval.point)} (${fmt(interval.lower)} to ${fmt(interval.upper)})`;
  return interval.significant
    ? range
    : `${range}, not significant at n=${interval.n}`;
}
