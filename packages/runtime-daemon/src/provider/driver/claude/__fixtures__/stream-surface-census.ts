// Golden vectors: Claude stream-json subtypes, read from the schema constructors in the Claude
// Code 2.1.251 binary. Names only: no authless probe records a stream frame body. Never
// hand-edit a subtype to make a test pass.

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

/** The binary maps `system/api_error` onto `system/api_retry`. */
export const CLAUDE_API_ERROR_TO_API_RETRY_MAPPING_ARM: readonly [string, string] = Object.freeze([
  "system/api_error",
  "system/api_retry",
] as const);
