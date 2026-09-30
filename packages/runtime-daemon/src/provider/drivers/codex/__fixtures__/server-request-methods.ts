// Golden vector: the Codex `ServerRequest` method census (Codex -> daemon callbacks, interactive
// input and approvals).
// Pin: codex-cli 0.150.1, from the generated schema (`codex app-server generate-json-schema`).
//
// The pinned reference records `ServerRequest` as exactly ten methods and names all ten; nothing
// here is invented. This is a method vector, not a payload vector: the reference reproduces no
// inbound server-request payload body, and a payload file could not be derived honestly from it.
// Payload-shaped cases go through typed constructors in `__tests__/event-normalizer.test.ts`.
//
// When the Codex pin moves, regenerate from the schema. Do not hand-edit a method string to make a
// test pass.

/** One row of the pinned `ServerRequest` method census. */
export interface CodexServerRequestMethodVector {
  /** The JSON-RPC `method` string, verbatim from the pinned generation. */
  readonly method: string;
  /**
   * `true` when the method is experimental: a default app-server connection never receives it, so
   * the driver must negotiate `initialize.capabilities.experimentalApi`.
   */
  readonly experimentalGatedAtPin: boolean;
  /** The reference subsection the row is read from. */
  readonly referenceSection: string;
}

/**
 * All ten `ServerRequest` methods at `codex-cli 0.150.1`: the callback tool, interactive input
 * (`item/tool/requestUserInput` is experimental-gated), approvals (three current, two legacy), and
 * the attestation and auth-refresh requests.
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
 * The `ServerRequest` arity at the pin. The test compares the vector list length against it, so a
 * dropped or added row fails loudly.
 */
export const CODEX_SERVER_REQUEST_METHOD_COUNT_AT_PIN = 10;
