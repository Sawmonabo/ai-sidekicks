// GOLDEN VECTOR — Codex `ServerRequest` method census.
//
//   Source doc      : docs/reference/provider-wire/codex.md
//   Section         : §Server-requests — the callback / interactive / approval
//                     surface (Codex -> daemon)
//   Pin             : codex-cli 0.150.1 (the `latest` dist-tag of
//                     `@openai/codex` at that doc's authoring)
//   Provenance      : Generated schema (`codex app-server generate-json-schema`
//                     / `generate-ts`), regenerated 2026-08-28
//   Trust           : Verified at 0.150.1
//   Derived by      : Plan-005 T3.5, transcribed from the reference's verbatim
//                     enumeration. NOTHING here is invented: codex.md records
//                     `ServerRequest` as carrying exactly ten methods at the
//                     pin ("the same 10 as at 0.141.0 — the one root that has
//                     not moved anywhere across the floor") and names all ten.
//                     The 0.149.1 -> 0.150.1 pin hop left this root untouched:
//                     zero added, zero removed, and `ServerRequest.json` itself
//                     byte-identical across the two generations.
//
// WHAT THIS FIXTURE IS, AND WHAT IT IS NOT.
//
// It is a METHOD census vector, not a payload vector. codex.md reproduces no
// inbound server-request or server-notification PAYLOAD body verbatim anywhere
// — every verbatim shape in it is a client-request params type
// (`ThreadRollbackParams`, `ThreadForkParams.lastTurnId`, `TurnStartParams`,
// `ThreadGoalSetParams`, `ThreadInjectItemsParams`) or a value union
// (`AskForApproval`, `ReviewDecision`). Under the family README's
// "regenerate, don't transcribe" rule a payload-bearing golden file cannot be
// honestly derived from this reference, and manufacturing one would give a
// fabricated shape the appearance of pinned provenance. So this file carries
// exactly what the reference DOES record verbatim — the method strings, their
// protocol root, and their experimental gating — and payload-shaped cases go
// through typed constructors in `__tests__/event-normalizer.test.ts`.
//
// Regeneration: when the Codex pin moves, re-run the commands in codex.md
// §Regeneration against the new binary and re-derive this file from the new
// generation. Do not hand-edit a method string here to make a test pass.

/** One row of the pinned `ServerRequest` method census. */
export interface CodexServerRequestMethodVector {
  /** The JSON-RPC `method` string, verbatim from the pinned generation. */
  readonly method: string;
  /**
   * `true` when the reference marks the method EXPERIMENTAL, i.e. a default
   * app-server connection never receives it and the driver must negotiate
   * `initialize.capabilities.experimentalApi` to be delivered it.
   */
  readonly experimentalGatedAtPin: boolean;
  /** The codex.md subsection the row is read from. */
  readonly referenceSection: string;
}

/**
 * All ten `ServerRequest` methods at `codex-cli 0.150.1`.
 *
 * codex.md §Server-requests, verbatim structure: callback tools
 * (`item/tool/call`); interactive input (`item/tool/requestUserInput`
 * — marked EXPERIMENTAL, "a default app-server session never delivers this
 * method, so the Plan-005 interactive-request leg must opt in at
 * `initialize`" — and `mcpServer/elicitation/request`); approvals modern
 * (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
 * `item/permissions/requestApproval`) and legacy (`execCommandApproval`,
 * `applyPatchApproval`); "also `attestation/generate`,
 * `account/chatgptAuthTokens/refresh`".
 */
export const CODEX_SERVER_REQUEST_METHOD_VECTORS: readonly CodexServerRequestMethodVector[] =
  Object.freeze([
    {
      method: "item/tool/call",
      experimentalGatedAtPin: false,
      referenceSection: "Server-requests",
    },
    {
      method: "item/tool/requestUserInput",
      experimentalGatedAtPin: true,
      referenceSection: "Server-requests",
    },
    {
      method: "mcpServer/elicitation/request",
      experimentalGatedAtPin: false,
      referenceSection: "Server-requests",
    },
    {
      method: "item/commandExecution/requestApproval",
      experimentalGatedAtPin: false,
      referenceSection: "Server-requests",
    },
    {
      method: "item/fileChange/requestApproval",
      experimentalGatedAtPin: false,
      referenceSection: "Server-requests",
    },
    {
      method: "item/permissions/requestApproval",
      experimentalGatedAtPin: false,
      referenceSection: "Server-requests",
    },
    {
      method: "execCommandApproval",
      experimentalGatedAtPin: false,
      referenceSection: "Server-requests",
    },
    {
      method: "applyPatchApproval",
      experimentalGatedAtPin: false,
      referenceSection: "Server-requests",
    },
    {
      method: "attestation/generate",
      experimentalGatedAtPin: false,
      referenceSection: "Server-requests",
    },
    {
      method: "account/chatgptAuthTokens/refresh",
      experimentalGatedAtPin: false,
      referenceSection: "Server-requests",
    },
  ] as const satisfies readonly CodexServerRequestMethodVector[]);

/**
 * The `ServerRequest` root's arity at the pin, quoted from codex.md
 * §Server-requests: "`ServerRequest` carries 10 methods at `0.150.1` — the
 * same 10 as at `0.141.0`".
 *
 * Pinned as a value so the vector list above cannot silently lose or gain a
 * row: the test asserts the list length against this count, which fails loudly
 * if a future edit drops a method rather than re-deriving from a new pin.
 */
export const CODEX_SERVER_REQUEST_METHOD_COUNT_AT_PIN = 10;
