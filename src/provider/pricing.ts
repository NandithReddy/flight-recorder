/**
 * Cost table.
 *
 * A regression report that only reports quality is half a report — the demo in
 * phase 0 showed why: the degraded agent was 33% cheaper, so anything tuned on
 * cost alone would have promoted it. Cost has to be measured as precisely as
 * pass rate, which means real prices, not estimates.
 *
 * Prices are USD per million tokens, as published by the provider. Sources are
 * noted per family; re-check them when a model launches, because nothing here
 * validates itself against the provider's billing.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** Promotional pricing in effect up to and including this date. */
  intro?: {
    inputPerMTok: number;
    outputPerMTok: number;
    /** ISO date, inclusive. */
    until: string;
  };
}

/**
 * Cache multipliers applied to the input rate. A cache read is roughly a tenth
 * of the base rate; a write costs a premium over it. These are provider-wide
 * for Anthropic rather than per-model.
 */
export const CACHE_MULTIPLIERS = {
  read: 0.1,
  write5m: 1.25,
  write1h: 2.0,
} as const;

/**
 * Keyed by canonical model id (dashes, no vendor prefix). Anthropic prices as
 * published on platform.claude.com; verified 2026-08.
 */
export const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-mythos-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    intro: { inputPerMTok: 2, outputPerMTok: 10, until: "2026-08-31" },
  },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * Gateway model ids carry a vendor prefix and spell versions with dots
 * (`anthropic/claude-opus-4.8`); the first-party API uses dashes and no prefix
 * (`claude-opus-4-8`). Same model, two spellings — normalise before lookup or
 * every gateway-run trace silently costs nothing.
 */
export function canonicalModelId(model: string): string {
  const withoutVendor = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return withoutVendor.replaceAll(".", "-").toLowerCase();
}

export interface PriceLookup {
  price: ModelPrice | null;
  inputPerMTok: number;
  outputPerMTok: number;
  /** True when the intro rate applied at the given date. */
  intro: boolean;
  /** True when the model is absent from the table and rates fell back to 0. */
  unknown: boolean;
}

export function priceFor(model: string, at: Date = new Date()): PriceLookup {
  const price = PRICES[canonicalModelId(model)];
  if (!price) {
    return {
      price: null,
      inputPerMTok: 0,
      outputPerMTok: 0,
      intro: false,
      unknown: true,
    };
  }

  const introActive =
    price.intro !== undefined && at.toISOString().slice(0, 10) <= price.intro.until;

  return {
    price,
    inputPerMTok: introActive ? price.intro!.inputPerMTok : price.inputPerMTok,
    outputPerMTok: introActive ? price.intro!.outputPerMTok : price.outputPerMTok,
    intro: introActive,
    unknown: false,
  };
}

export interface CostInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteTtl?: "5m" | "1h";
  at?: Date;
}

/**
 * Returns cost in USD, and whether the model was priced at all. An unknown
 * model yields 0 with `unknown: true` — the report surfaces that rather than
 * quietly presenting a free run.
 */
export function costOf(input: CostInput): { costUsd: number; unknown: boolean } {
  const lookup = priceFor(input.model, input.at);
  const perInput = lookup.inputPerMTok / 1_000_000;
  const perOutput = lookup.outputPerMTok / 1_000_000;
  const writeMultiplier =
    input.cacheWriteTtl === "1h" ? CACHE_MULTIPLIERS.write1h : CACHE_MULTIPLIERS.write5m;

  const costUsd =
    input.inputTokens * perInput +
    input.outputTokens * perOutput +
    (input.cacheReadTokens ?? 0) * perInput * CACHE_MULTIPLIERS.read +
    (input.cacheWriteTokens ?? 0) * perInput * writeMultiplier;

  return { costUsd, unknown: lookup.unknown };
}
