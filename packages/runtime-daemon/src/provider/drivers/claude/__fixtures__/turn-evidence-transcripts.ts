// GOLDEN VECTOR - Claude turn-evidence result frames (T3.18).
//
//   Source doc      : docs/reference/provider-wire/claude.md
//   Section         : §Client-side command interception on the programmatic
//                     input surface
//   Pin             : Claude Code 2.1.251 (the native single-file build named
//                     in that doc's §Version pin)
//   Provenance      : Binary probe. Three live `claude -p --output-format
//                     stream-json` runs against the on-disk build on
//                     2026-08-29, in one pass, same model and same session
//                     shape, differing only in the message body: a
//                     command-shaped first word, that same body with one
//                     prepended newline, and ordinary prose.
//   Trust           : Verified at 2.1.251. Every number below is a reading, not
//                     an illustration. The `2.1.245` behaviour Spec-005 records
//                     reproduced unchanged at this pin, so it is a standing
//                     property of this input surface rather than one build's
//                     regression.
//   Derived by      : Plan-005 T3.18.
//
// WHAT THIS FIXTURE IS FOR.
//
// The zero-turn body is the normative instance every driver's turn-evidence
// classifier must trip on: a client-composed reply with no model-turn
// attribution and no token usage, delivered inside a well-formed SUCCESS
// envelope. The other two are its negative controls, and the second of them is
// the sharper one - a genuine, billed turn that ended in a provider-side
// refusal, which reports `is_error: true` and renders its assistant message
// with the same synthetic model marker the swallowed reply wears. A classifier
// keyed on either field passes the swallow and fails the real turn.
//
// Frozen, and typed as a read-only record: these are shared module-level
// singletons, and a consumer mutating one would silently re-point every other
// consumer's control.

/** The recorded zero-turn synthetic reply - the swallowed turn. */
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

/** The recorded ordinary turn - the primary negative control. */
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

/**
 * The recorded turn that reached the model and then hit a provider-side
 * refusal - the counterexample to `is_error` and to the synthetic model marker.
 */
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
