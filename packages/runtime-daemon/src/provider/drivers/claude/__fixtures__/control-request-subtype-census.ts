// Golden vectors: Claude control-request subtype census, pinned to Claude Code 2.1.251 (native
// single-file build). Source: a schema-constructor census of the binary taken at 2.1.245. It was
// not re-run at 2.1.251, so the exactly-once arity and the counterexample zero-counts below are
// 2.1.245 measurements. The re-check at 2.1.251 was weaker: all sixteen subtype strings still
// occur as quoted literals, which shows no recorded member vanished and cannot re-derive registry
// membership. The registry set also read the same at 2.1.246.
//
// The census lists fifteen subtypes, each appearing exactly once, names three counterexample
// subtypes at count 0, and gives the `mcp_set_servers` reconcile body character for character.
//
// This is a subtype vector plus that one response body, not a request-payload vector. Apart
// from the `can_use_tool` field names and the `control_response` error envelope's member names,
// the census recorded no control-request or control-response body, and a body cannot be
// derived from it without fabricating a shape. Payload-shaped cases go through typed
// constructors in `__tests__/event-normalizer.test.ts`.
//
// When the Claude pin moves, re-run the census against the new binary and re-derive this file.
// Never hand-edit a subtype string to make a test pass.

/** One row of the pinned control-request subtype census. */
export interface ClaudeControlRequestSubtypeVector {
  /** The control-request `subtype` string, verbatim from the census. */
  readonly subtype: string;
  /**
   * Whether the subtype appears in the censused registry. `false` marks a subtype the census
   * could not see that still dispatches: the flag records census visibility, never capability.
   */
  readonly presentInCensusedRegistry: boolean;
  /** The census section the row is read from. */
  readonly referenceSection: string;
}

/**
 * The fifteen censused control-request subtypes, in census order, plus `mcp_set_servers` last.
 *
 * `mcp_set_servers` is not in the censused registry but answered `{"subtype":"success", ...}`
 * at all three probed builds, while a negative control (`zzq_nonexistent_subtype`) was refused
 * every time with "Unsupported control request subtype: ...", so the dispatcher is not simply
 * permissive.
 */
export const CLAUDE_CONTROL_REQUEST_SUBTYPE_VECTORS: readonly ClaudeControlRequestSubtypeVector[] =
  Object.freeze([
    {
      subtype: "interrupt",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "set_permission_mode",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "can_use_tool",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "set_model",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "get_usage",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "get_context_usage",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "get_session_cost",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "list_models",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "get_binary_version",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "apply_flag_settings",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "rewind_files",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "hook_callback",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "elicitation",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "request_user_dialog",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "mcp_message",
      presentInCensusedRegistry: true,
      referenceSection: "Control-request registry (binary census)",
    },
    {
      subtype: "mcp_set_servers",
      presentInCensusedRegistry: false,
      referenceSection:
        "Control-request registry (binary census) - the census is a lower bound, not an upper one",
    },
  ] as const);

/** How many subtypes the binary census itself listed at the pin. */
export const CLAUDE_CENSUSED_CONTROL_REQUEST_SUBTYPE_COUNT_AT_PIN = 15;

/**
 * The three subtypes the counterexample hunt found at count 0 (2.1.245 counts, not re-run).
 *
 * A raw string count does not reproduce them: `rewind` and `compact` occur as quoted literals
 * in both builds. Absence never proves a subtype does not exist and census presence or absence
 * never decides a capability; it only means no probe answer is recorded, so no census row
 * exists.
 */
export const CLAUDE_CONTROL_REQUEST_SUBTYPES_ABSENT_AT_PIN: readonly string[] = Object.freeze([
  "set_effort",
  "rewind",
  "compact",
] as const);

/**
 * The one control-channel response body the census captured, byte for byte: the
 * `mcp_set_servers` reconcile answer at 2.1.234, 2.1.245 and 2.1.246 over
 * `-p --input-format stream-json`, with an empty desired set and no billed turn. It shows the
 * subtype dispatches and returns the reconcile envelope; a non-empty mutation was not probed.
 *
 * Held as a string so the bytes (key order, spacing) are the fixture and the test asserts the
 * parse.
 */
export const CLAUDE_MCP_SET_SERVERS_RECONCILE_RESPONSE_JSON =
  '{"subtype":"success","response":{"added":[],"removed":[],"errors":{}}}';

/**
 * The `control_response` error-envelope member names, from the census shape
 * `{ type: "control_response", response: { subtype: "error", request_id, error } }`. Names
 * only, because the census gives a shape and no instance.
 */
export const CLAUDE_CONTROL_RESPONSE_ERROR_ENVELOPE_MEMBERS: readonly string[] = Object.freeze([
  "subtype",
  "request_id",
  "error",
] as const);

/**
 * The `can_use_tool` request member names. The census records the round trip as the
 * `--permission-prompt-tool` plumbing, `{tool_name, input}` answered by
 * `{behavior: allow | deny, updatedInput?, message?}`, with a `{behavior: "cancelled"}` arm.
 */
export const CLAUDE_CAN_USE_TOOL_REQUEST_MEMBERS: readonly string[] = Object.freeze([
  "tool_name",
  "input",
] as const);

/** The `can_use_tool` response `behavior` values recorded at the pin. */
export const CLAUDE_CAN_USE_TOOL_BEHAVIORS: readonly string[] = Object.freeze([
  "allow",
  "deny",
  "cancelled",
] as const);
