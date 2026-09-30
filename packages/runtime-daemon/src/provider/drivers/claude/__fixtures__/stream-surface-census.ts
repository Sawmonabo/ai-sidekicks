// Golden vectors: Claude stream-json subtype and field-name census, pinned to Claude Code
// 2.1.251 (native single-file build). Source: a schema-constructor census of the binary taken at
// 2.1.245; every string below was re-checked to still occur as a literal token in the 2.1.251
// build (quoted or bare: four are emitted unquoted as object keys in both builds). Presence is
// all that re-check establishes. The result-subtype set and the init capability tokens also
// read the same at 2.1.246. Set closure is only derived, since a string census cannot prove a
// set is closed.
//
// This is a subtype and field-name census, not a frame-body vector. The only JSON body it
// captured verbatim is the `mcp_set_servers` reconcile answer in
// `control-request-subtype-census.ts`. A stream frame body cannot be added by inspection: no
// authless protocol probe exists for this provider.
//
// When the Claude pin moves, re-census the new binary and re-derive this file. Never hand-edit
// a subtype string to make a test pass.

/**
 * The five `result` subtypes at the pin, in census order.
 *
 * Two facts belong to the driver read loop: the `result` field is present only on `success`,
 * and trailing events such as `prompt_suggestion` can arrive after `result`, so the loop reads
 * to EOF instead of stopping at `result`.
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
 * Adjacent stream subtypes present in the binary at the pin.
 *
 * Only `rate_limit_event` and `compact_boundary` have a normalizer disposition. The other four
 * are present on the wire but outside the normalizer's kind set, which is the condition the
 * driver's unrecognized-frame diagnostic exists to surface.
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
 * The `system/api_retry` frame's member names, as the census records the shape:
 * `{ type: "system", subtype: "api_retry", attempt, max_retries, retry_delay_ms, error_status,
 * error }`. `error_status` sits alongside the typed `error`.
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
 * Advisory only: use it to recognize a member, never to reject one. The census cannot prove the
 * set is closed, so rejecting an unknown literal would drop a retry the moment the vendor adds
 * one.
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

/** The retry-channel mapping arm the census states: `system/api_error` to `system/api_retry`. */
export const CLAUDE_API_ERROR_TO_API_RETRY_MAPPING_ARM: readonly [string, string] = Object.freeze([
  "system/api_error",
  "system/api_retry",
] as const);

/**
 * The `system/init` `capabilities` tokens present as literals at the pin.
 *
 * The vendor documents the field as an open set: ignore unknown values and check each
 * capability for exactly the behavior you use. A one-build census cannot say which release
 * introduced a token.
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
 * The pinned CLI version every vector in this directory is recorded against. It is the version
 * a running build is compared with, not the older build the census was extracted from.
 */
export const CLAUDE_WIRE_PIN_VERSION = "2.1.251";
