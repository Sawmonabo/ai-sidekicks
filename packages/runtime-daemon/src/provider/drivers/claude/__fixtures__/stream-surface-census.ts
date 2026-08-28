// GOLDEN VECTOR - Claude stream-json surface census.
//
//   Source doc      : docs/reference/provider-wire/claude.md
//   Section         : §Result and stream surface; §`system/init` `capabilities`
//                     - an open set, per-token
//   Pin             : Claude Code 2.1.245 (the native single-file build named
//                     in that doc's §Version pin)
//   Provenance      : Binary probe, censused 2026-08-25
//   Trust           : Verified at 2.1.245 for every string below; the result
//                     -subtype set and the init capability tokens are
//                     additionally recorded unchanged at 2.1.246. Set-CLOSURE
//                     is marked Derived by the reference itself, "since a
//                     string census cannot prove a set is closed" - which is
//                     why `CLAUDE_API_RETRY_TYPED_ERRORS` below must never be
//                     used to REJECT an unrecognized member.
//   Derived by      : Plan-005 T3.10, transcribed from the reference's
//                     verbatim enumerations. NOTHING here is invented.
//
// WHAT THIS FIXTURE IS, AND WHAT IT IS NOT.
//
// It is a SUBTYPE and FIELD-NAME census, not a frame-body vector. claude.md
// reproduces exactly one JSON body verbatim in the whole file (the
// `mcp_set_servers` reconcile answer, carried in
// `control-request-subtype-census.ts`); everywhere else it records names,
// shapes, and vendor prose. §Gaps states the reason a stream frame body cannot
// be added here later by inspection alone: "No authless protocol probe exists
// for this provider ... there is no way to observe Claude's stream-json
// handshake without a token."
//
// Regeneration: when the Claude pin moves, re-census the new binary per
// claude.md §Provenance and re-derive this file. Do not hand-edit a subtype
// string here to make a test pass.

/**
 * The five `result` subtypes at the pin, in the reference's own order.
 *
 * claude.md records two consequences that belong to the driver read loop
 * rather than to the normalizer, and are restated here so a reader of this
 * fixture does not have to re-derive them: the `result` field is present ONLY
 * on `success`, and trailing events (it names `prompt_suggestion`) can arrive
 * AFTER `result`, so the read loop reads to EOF rather than breaking on
 * `result`.
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
 * Adjacent stream subtypes present at the pin (Binary probe, Verified).
 *
 * Six strings, only two of which any disposition table covers
 * (`rate_limit_event` via census row 20's rename, `compact_boundary` via row
 * 19). The other four are carried here precisely so the normalizer's
 * deliberate exclusion of them is a checkable fact: they are Verified present
 * on the wire AND absent from the 35-kind census, which is the exact condition
 * the Plan-005 T3.11 diagnostic exists to surface.
 */
export const CLAUDE_ADJACENT_STREAM_SUBTYPES: readonly string[] = Object.freeze([
  "rate_limit_event",
  "compact_boundary",
  "command_lifecycle",
  "queued_notification",
  "model_refusal_fallback",
  "model_refusal_no_fallback",
] as const);

/**
 * The `system/api_retry` frame's member names, from the shape claude.md
 * records verbatim:
 * `{ type: "system", subtype: "api_retry", attempt, max_retries,
 *    retry_delay_ms, error_status, error }`.
 *
 * Note `error_status` sits alongside the typed `error`; the reference calls
 * that pairing out explicitly.
 */
export const CLAUDE_API_RETRY_FRAME_MEMBERS: readonly string[] = Object.freeze([
  "type",
  "subtype",
  "attempt",
  "max_retries",
  "retry_delay_ms",
  "error_status",
  "error",
] as const);

/**
 * The `api_retry` typed-error literals present in the binary at the pin.
 *
 * ADVISORY ONLY. claude.md grades the union's exact arity **Derived**, "since
 * a string census cannot prove a set is closed", so this list may be used to
 * RECOGNIZE a member and must never be used to REJECT one: failing closed on
 * an unrecognized member would turn a set the evidence cannot close into an
 * enforced allow-list, dropping a capability-bearing retry the moment the
 * vendor adds a literal.
 */
export const CLAUDE_API_RETRY_TYPED_ERRORS: readonly string[] = Object.freeze([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "max_output_tokens",
  "unknown",
] as const);

/**
 * The mapping arm claude.md states verbatim for the retry channel:
 * "the mapping arm is `system/api_error` -> `system/api_retry`".
 *
 * Carried as a pair so the normalizer's decision to give both frame kinds the
 * same family target is traceable to the reference rather than to inference.
 */
export const CLAUDE_API_ERROR_TO_API_RETRY_MAPPING_ARM: readonly [string, string] = Object.freeze([
  "system/api_error",
  "system/api_retry",
] as const);

/**
 * The `system/init` `capabilities` tokens present as literals at the pin.
 *
 * The field is an OPEN set by the vendor's own statement, quoted in claude.md:
 * "Open set - ignore unknown values; check each capability for exactly the
 * behavior you use." Which release each token first appeared in is only
 * **Documented**, because a census of one build cannot date a token's arrival.
 */
export const CLAUDE_INIT_CAPABILITY_TOKENS: readonly string[] = Object.freeze([
  "interrupt_receipt_v1",
  "interrupt_cancel_queued_v1",
  "queued_notifications",
  "still_queued",
  "queued_notification",
  "msg_lifecycle_v1",
] as const);

/**
 * The `get_usage` response window keys at the pin, plus the two sibling fields
 * that gate reading them.
 *
 * Kept beside the stream census because claude.md names `system/rate_limit_event`
 * the PREFERRED carrier for the same account-plane quota data - "a push channel
 * that does not require the experimental `get_usage` round trip" - so a reader
 * comparing the two surfaces needs both in one place.
 */
export const CLAUDE_GET_USAGE_RATE_LIMIT_WINDOW_KEYS: readonly string[] = Object.freeze([
  "five_hour",
  "seven_day",
  "seven_day_oauth_apps",
  "seven_day_opus",
  "seven_day_sonnet",
] as const);

/** The `get_usage` response fields that must be read BEFORE `rate_limits`. */
export const CLAUDE_GET_USAGE_GATING_FIELDS: readonly string[] = Object.freeze([
  "rate_limits_available",
  "subscription_type",
] as const);

/**
 * The `get_binary_version` response member names.
 *
 * claude.md records the in-band version channel returning `{ version,
 * buildTime }` for the build actually running, and warns that
 * `claude --version` reports the launcher's build instead - the two came apart
 * mid-census.
 */
export const CLAUDE_GET_BINARY_VERSION_RESPONSE_MEMBERS: readonly [string, string] = Object.freeze([
  "version",
  "buildTime",
] as const);

/** The pinned CLI version every vector in this directory was censused from. */
export const CLAUDE_WIRE_PIN_VERSION = "2.1.245";
