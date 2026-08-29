// GOLDEN VECTOR - Claude control-request subtype census.
//
//   Source doc      : docs/reference/provider-wire/claude.md
//   Section         : §Control-request registry (binary census)
//   Pin             : Claude Code 2.1.251 (the native single-file build named
//                     in that doc's §Version pin)
//   Provenance      : Binary probe (schema constructors observed directly in
//                     the binary), censused 2026-08-25 at 2.1.245 and CARRIED
//                     to the pin per claude.md §Version pin "Carried census".
//                     The schema-constructor extraction was NOT re-run on
//                     2026-08-28, so BOTH the exactly-once arity and the
//                     counterexample zero-counts below remain 2.1.245
//                     measurements. The 2026-08-28 pass ran the strictly weaker
//                     check its evidence supports - that all sixteen subtype
//                     strings below still occur as quoted literals in the
//                     2.1.251 build - which shows no recorded member vanished
//                     and CANNOT re-derive registry membership either way.
//   Trust           : Verified at 2.1.245, members re-verified present at
//                     2.1.251; the registry set is additionally recorded
//                     unchanged at 2.1.246
//   Derived by      : Plan-005 T3.10, transcribed from the reference's
//                     verbatim enumeration. NOTHING here is invented: the
//                     reference lists all fifteen subtypes on one line, states
//                     that each "appears exactly once in the census", names
//                     the three counterexample subtypes it found at count 0,
//                     and reproduces the `mcp_set_servers` reconcile body
//                     character for character.
//
// WHAT THIS FIXTURE IS, AND WHAT IT IS NOT.
//
// It is a SUBTYPE census vector plus the single response body claude.md
// reproduces verbatim. It is not a request-payload vector: apart from the
// `can_use_tool` field names and the `control_response` error envelope's
// member names, the reference records no control-request or control-response
// BODY. Under the family README's "regenerate, don't transcribe" rule a
// payload-bearing golden file cannot be honestly derived from this reference,
// and manufacturing one would give a fabricated shape the appearance of pinned
// provenance. Payload-shaped cases go through typed constructors in
// `__tests__/event-normalizer.test.ts` instead.
//
// Regeneration: when the Claude pin moves, re-run the census described in
// claude.md §Control-request registry against the new binary and re-derive
// this file from it. Do not hand-edit a subtype string here to make a test
// pass.

/** One row of the pinned control-request subtype census. */
export interface ClaudeControlRequestSubtypeVector {
  /** The control-request `subtype` string, verbatim from the pinned census. */
  readonly subtype: string;
  /**
   * `true` when the subtype appears in the binary's censused registry.
   * `false` marks a subtype the census could NOT see that nevertheless
   * dispatches - claude.md states outright that its registry list "is evidence
   * about what the census could see, never a completeness claim", so this flag
   * records census visibility and never capability.
   */
  readonly presentInCensusedRegistry: boolean;
  /** The claude.md subsection the row is read from. */
  readonly referenceSection: string;
}

/**
 * The fifteen censused control-request subtypes at `2.1.245`, all still
 * present at the `2.1.251` pin, plus `mcp_set_servers`.
 *
 * Order is the reference's own, left to right on its enumeration line, with
 * the censused-absent-but-answering subtype appended last so the first fifteen
 * are exactly the registry list.
 *
 * `mcp_set_servers` is included because claude.md records it answering
 * `{"subtype":"success", ...}` at all three probed builds beside a negative
 * control (`zzq_nonexistent_subtype`, refused every time with the typed
 * "Unsupported control request subtype: ..."), so the successes are not an
 * artifact of a permissive dispatcher.
 */
export const CLAUDE_CONTROL_REQUEST_SUBTYPE_VECTORS: readonly ClaudeControlRequestSubtypeVector[] =
  Object.freeze([
    {
      subtype: "interrupt",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "set_permission_mode",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "can_use_tool",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "set_model",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "get_usage",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "get_context_usage",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "get_session_cost",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "list_models",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "get_binary_version",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "apply_flag_settings",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "rewind_files",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "hook_callback",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "elicitation",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "request_user_dialog",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "mcp_message",
      presentInCensusedRegistry: true,
      referenceSection: "§Control-request registry (binary census)",
    },
    {
      subtype: "mcp_set_servers",
      presentInCensusedRegistry: false,
      referenceSection:
        "§Control-request registry (binary census) - the census is a lower bound, not an upper one",
    },
  ] as const);

/** How many subtypes the binary census itself listed at the pin. */
export const CLAUDE_CENSUSED_CONTROL_REQUEST_SUBTYPE_COUNT_AT_PIN = 15;

/**
 * The three subtypes claude.md's counterexample hunt found at count 0.
 *
 * Carried so the normalizer's exclusion of them is checkable rather than
 * implicit. These are `2.1.245` counts, carried to the `2.1.251` pin unre-run:
 * a raw string count is not the census that produced them (`rewind` and
 * `compact` occur as quoted literals in BOTH builds, so the naive check would
 * contradict a census reading it cannot reproduce). Absence is NOT read as proof of non-existence
 * anywhere in this package - the same reference section states that "neither presence nor
 * absence in it may decide a capability" - it is read only as "no probe answer
 * is recorded for these, so no census row can be written for them".
 */
export const CLAUDE_CONTROL_REQUEST_SUBTYPES_ABSENT_AT_PIN: readonly string[] = Object.freeze([
  "set_effort",
  "rewind",
  "compact",
] as const);

/**
 * The one control-channel response body claude.md reproduces verbatim, kept
 * byte for byte.
 *
 * It is the `mcp_set_servers` reconcile answer observed at 2.1.234, 2.1.245,
 * and 2.1.246 over `-p --input-format stream-json`, with an EMPTY desired set,
 * no user message sent, and no billed turn. What is Verified is that the
 * subtype dispatches and returns the documented reconcile envelope; a
 * non-empty mutation is outside that probe's reach.
 *
 * Held as a string rather than a parsed literal so the bytes themselves are
 * the fixture - key order, spacing, and all - and the test asserts the parse
 * rather than assuming it.
 */
export const CLAUDE_MCP_SET_SERVERS_RECONCILE_RESPONSE_JSON =
  '{"subtype":"success","response":{"added":[],"removed":[],"errors":{}}}';

/**
 * The `control_response` error-envelope member names, from the shape claude.md
 * records verbatim:
 * `{ type: "control_response", response: { subtype: "error", request_id, error } }`.
 *
 * Recorded as member NAMES rather than as a constructed body, because the
 * reference gives the shape and not an instance.
 */
export const CLAUDE_CONTROL_RESPONSE_ERROR_ENVELOPE_MEMBERS: readonly string[] = Object.freeze([
  "subtype",
  "request_id",
  "error",
] as const);

/**
 * The `can_use_tool` round-trip member names, from claude.md's verbatim
 * statement that it "remains the `--permission-prompt-tool` plumbing
 * (`{tool_name, input}` -> `{behavior: allow | deny, updatedInput?, message?}`)"
 * with "a `{behavior: "cancelled"}` response arm alongside those".
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
