// Golden vectors: Claude stream-json subtypes, pinned to Claude Code 2.1.251. Read from the
// schema constructors in the 2.1.245 binary; each string still occurs as a literal at 2.1.251.
// Names only: no authless probe records a stream frame body. When the pin moves, re-read the
// new binary and re-derive this file; never hand-edit a subtype to make a test pass.

/**
 * The five `result` subtypes. The `result` field is present only on `success`, and trailing
 * events such as `prompt_suggestion` can arrive after `result`, so the read loop reads to EOF.
 */
export const CLAUDE_RESULT_SUBTYPES: readonly string[] = Object.freeze([
  "success",
  "error_max_turns",
  "error_max_budget_usd",
  "error_during_execution",
  "error_max_structured_output_retries",
] as const);

/** The single `result` subtype that carries a `result` field. */
export const CLAUDE_RESULT_SUBTYPE_CARRYING_RESULT_FIELD = "success";

/**
 * Adjacent stream subtypes present in the binary. Only `rate_limit_event` and `compact_boundary`
 * have a normalizer disposition; the other four are on the wire but outside the normalizer's
 * kind set, which is what the unrecognized-frame diagnostic exists to surface.
 */
export const CLAUDE_ADJACENT_STREAM_SUBTYPES: readonly string[] = Object.freeze([
  "rate_limit_event",
  "compact_boundary",
  "command_lifecycle",
  "queued_notification",
  "model_refusal_fallback",
  "model_refusal_no_fallback",
] as const);

/** The binary maps `system/api_error` onto `system/api_retry`. */
export const CLAUDE_API_ERROR_TO_API_RETRY_MAPPING_ARM: readonly [string, string] = Object.freeze([
  "system/api_error",
  "system/api_retry",
] as const);
