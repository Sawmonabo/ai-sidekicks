// Golden vectors: Claude `result` frames recorded from Claude Code 2.1.251 (native single-file
// build). Source: three live `claude -p --output-format stream-json` runs against that build,
// same model and session shape, differing only in the message body (a command-shaped first
// word, the same body with one prepended newline, ordinary prose). Every number is a reading.
//
// The zero-turn frame is a command Claude Code answered itself: a client-composed reply with no
// model-turn attribution and no token usage, inside a well-formed success envelope. The other
// two are negative controls. The API-errored one is the sharper: a real, billed turn that ended
// in a provider-side refusal reports `is_error: true` and renders its assistant message with the
// same synthetic model marker the zero-turn reply wears, so a classifier keyed on either field
// reads the zero-turn reply as a turn and the real turn as none.
//
// The frames are frozen: they are shared module-level singletons, and a consumer mutating
// one would re-point every other consumer's control.

/** The recorded zero-turn synthetic reply: a command answered with no model turn. */
export const CLAUDE_ZERO_TURN_RESULT_FRAME: Readonly<Record<string, unknown>> = Object.freeze({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 15,
  duration_api_ms: 0,
  num_turns: 0,
  total_cost_usd: 0,
  modelUsage: {},
  session_id: "32712e4d-5593-4b99-a93d-a9ae2af46bb7",
});

/** The recorded ordinary turn: the primary negative control. */
export const CLAUDE_ORDINARY_TURN_RESULT_FRAME: Readonly<Record<string, unknown>> = Object.freeze({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 3095,
  duration_api_ms: 2972,
  num_turns: 1,
  total_cost_usd: 0.67144,
  modelUsage: {
    "claude-fable-5": { inputTokens: 2, outputTokens: 98, costUSD: 0.67144 },
  },
  session_id: "f35a6a12-0bd6-48e7-a4cf-e4e977f84031",
});

/** The recorded turn that reached the model and hit a provider-side refusal. */
export const CLAUDE_API_ERRORED_TURN_RESULT_FRAME: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: "result",
    subtype: "success",
    is_error: true,
    duration_api_ms: 2473,
    num_turns: 1,
    total_cost_usd: 0.66676,
    modelUsage: { "claude-fable-5": { inputTokens: 4, outputTokens: 12 } },
  });
