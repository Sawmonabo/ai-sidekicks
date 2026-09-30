// The `result` frame subtypes, extracted from the Claude Code 2.1.245 binary; each still occurs in
// the pinned 2.1.251 build. When the pin moves, re-read them from the new binary; never hand-edit
// one to make a test pass.

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
