/**
 * OpenTelemetry GenAI semantic conventions.
 *
 * We do not invent a span format. These attribute names come from the
 * OpenTelemetry incubating semantic conventions, which means a Flight Recorder
 * trace lands in any OTel-aware collector already knowing what a model call is.
 *
 * The constants live in the `/incubating` entrypoint — GenAI has not stabilised
 * yet, so the stable entrypoint does not export them. Importing from one place
 * here means the eventual promotion to stable is a single-file change.
 */

import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
} from "@opentelemetry/semantic-conventions/incubating";

export const GenAI = {
  SYSTEM: ATTR_GEN_AI_SYSTEM,
  OPERATION_NAME: ATTR_GEN_AI_OPERATION_NAME,
  REQUEST_MODEL: ATTR_GEN_AI_REQUEST_MODEL,
  REQUEST_TEMPERATURE: ATTR_GEN_AI_REQUEST_TEMPERATURE,
  REQUEST_MAX_TOKENS: ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  RESPONSE_MODEL: ATTR_GEN_AI_RESPONSE_MODEL,
  RESPONSE_FINISH_REASONS: ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  USAGE_INPUT_TOKENS: ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  USAGE_OUTPUT_TOKENS: ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  TOOL_NAME: ATTR_GEN_AI_TOOL_NAME,
  TOOL_CALL_ID: ATTR_GEN_AI_TOOL_CALL_ID,
} as const;

export const OPERATION_CHAT = GEN_AI_OPERATION_NAME_VALUE_CHAT;
export const OPERATION_EXECUTE_TOOL = GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL;

/**
 * Attributes with no GenAI equivalent. Namespaced so a collector can tell our
 * extensions apart from the spec's.
 */
export const FR = {
  TRACE_ID: "flightrecorder.trace.id",
  SPAN_ID: "flightrecorder.span.id",
  CONFIG_ID: "flightrecorder.config.id",
  AGENT_NAME: "flightrecorder.agent.name",
  AGENT_VERSION: "flightrecorder.agent.version",
  COST_USD: "flightrecorder.usage.cost_usd",
  REPLAY_OF: "flightrecorder.replay_of",
} as const;

export const TRACER_NAME = "flight-recorder";
export const TRACER_VERSION = "0.1.0";
