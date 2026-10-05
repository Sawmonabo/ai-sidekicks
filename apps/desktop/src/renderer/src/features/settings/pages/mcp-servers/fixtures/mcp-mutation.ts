// The governance mutation this fixture body sends and the idempotency key it mints.
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
} from "@ai-sidekicks/contracts/mcp/mcp";
import type { Refusal } from "#renderer/lib/refusal/refusal.js";

/**
 * How a mutation this fixture body sent has settled. `refused` is a send that rejected,
 * carrying the service's own words.
 */
export type McpMutationOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly binding: McpServerBindingRef }
  | {
      readonly kind: "settled";
      readonly binding: McpServerBindingRef;
      readonly result: McpMutationResult;
    }
  | {
      readonly kind: "refused";
      readonly binding: McpServerBindingRef;
      readonly refusal: Refusal;
    };

/** The outcome a row starts in and returns to. Shared so it has one spelling. */
export const IDLE_MCP_MUTATION: McpMutationOutcome = { kind: "idle" };

/** Mints the key one press carries. Injected so a test can drive a retry. */
export type IdempotencyKeyMinter = () => string;

/** Sends a binding's enablement change to the daemon. */
export type SendMcpEnabled = (request: McpSetEnabledRequest) => Promise<McpMutationResult>;

/** The default minter: the platform's own identifier source. */
export function mintIdempotencyKey(): string {
  return crypto.randomUUID();
}
