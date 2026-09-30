// The two governance mutations this fixture body sends and the idempotency key it mints.
//
// The key is minted once per press by the view: `clientIdempotencyKey` means "this is the same
// operation", which only the view that watched the press can know, so a key minted inside the
// port would make each retry a new operation. It is carried unchanged through every attempt of
// one press. It is injected, with `crypto.randomUUID()` as the default, so a test can assert a
// retry reused a key. Nothing here decides whether a control may be pressed: every control is
// offered.

import type {
  McpMutationResult,
  McpServerBindingRef,
  McpSetEnabledRequest,
  McpSetTrustRequest,
} from "@ai-sidekicks/contracts";

/** How a mutation this fixture body sent has settled. */
export type McpMutationOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly binding: McpServerBindingRef }
  | {
      readonly kind: "settled";
      readonly binding: McpServerBindingRef;
      readonly result: McpMutationResult;
    };

/** The outcome a row starts in and returns to. Shared so it has one spelling. */
export const IDLE_MCP_MUTATION: McpMutationOutcome = { kind: "idle" };

/** Mints the key one press carries. Injected so a test can drive a retry. */
export type IdempotencyKeyMinter = () => string;

/** Sends a binding's enablement change to the daemon. */
export type SendMcpEnabled = (request: McpSetEnabledRequest) => Promise<McpMutationResult>;

/** Sends a binding's trust change to the daemon. */
export type SendMcpTrust = (request: McpSetTrustRequest) => Promise<McpMutationResult>;

/** The default minter: the platform's own identifier source. */
export function mintIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Turn a binding's toggle press into a settled outcome.
 *
 * The binding travels back so outcomes render per binding; one aggregate verdict could not say
 * which row a result was about.
 */
export async function setBindingEnabled(options: {
  readonly send: SendMcpEnabled;
  readonly binding: McpServerBindingRef;
  readonly enabled: boolean;
  readonly idempotencyKey: string;
}): Promise<McpMutationOutcome> {
  const { send, binding, enabled, idempotencyKey } = options;
  return {
    kind: "settled",
    binding,
    result: await send({ ...binding, enabled, clientIdempotencyKey: idempotencyKey }),
  };
}

/**
 * Turn a binding's trust press into a settled outcome.
 *
 * A trust grant binds at the daemon and reaches no provider config, so its reply carries
 * `daemon_enforced` and no live results. The page renders that difference, since one result
 * shape carries both.
 */
export async function setBindingTrust(options: {
  readonly send: SendMcpTrust;
  readonly binding: McpServerBindingRef;
  readonly trusted: boolean;
  readonly idempotencyKey: string;
}): Promise<McpMutationOutcome> {
  const { send, binding, trusted, idempotencyKey } = options;
  return {
    kind: "settled",
    binding,
    result: await send({ ...binding, trusted, clientIdempotencyKey: idempotencyKey }),
  };
}
