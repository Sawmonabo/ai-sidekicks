// The two governance mutations this shell sends, the idempotency key it mints, and the
// key a binding is identified by.
//
// THE KEY IS THE CALLER'S AND IT IS MINTED ONCE PER PRESS. Every governance mutation
// carries a `clientIdempotencyKey`, and what it means is "this is the same operation",
// which only the surface that watched a person press the control can know. A key
// minted inside the port would make every retry of one press a second operation — the
// exact opposite of what the member is for — so it is minted here, on the press, and
// carried unchanged through however many attempts one press produces.
//
// AND IT IS INJECTED RATHER THAN READ OFF THE PLATFORM, on the run-control dispatch
// precedent: `crypto.randomUUID()` is the default and a test hands in a counter, so a
// suite can assert that a retry reused a key instead of asserting that two keys are
// both strings.
//
// NOTHING HERE DECIDES WHETHER A CONTROL MAY BE PRESSED. The governing surface makes
// that explicit: eligibility is not projected at all, no field reports it, every
// control is offered. So this module has no precondition to check and no arm for
// "not allowed".

import type {
  McpMutationResult,
  McpServerBindingRef,
  McpSetEnabledRequest,
  McpSetTrustRequest,
} from "@ai-sidekicks/contracts";

import { structuralKey } from "@renderer/lib/structural-key.js";

/** How a mutation this shell sent has settled. */
export type McpMutationOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly binding: McpServerBindingRef }
  | {
      readonly kind: "settled";
      readonly binding: McpServerBindingRef;
      readonly result: McpMutationResult;
    };

/** The outcome a shell starts in and returns to. Shared so it has one spelling. */
export const IDLE_MCP_MUTATION: McpMutationOutcome = { kind: "idle" };

/** Mints the key one press carries. Injected so a test can drive a retry. */
export type IdempotencyKeyMinter = () => string;

/** Sends a binding's enablement change to the daemon. */
export type SendMcpEnabled = (request: McpSetEnabledRequest) => Promise<McpMutationResult>;

/** Sends a binding's trust change to the daemon. */
export type SendMcpTrust = (request: McpSetTrustRequest) => Promise<McpMutationResult>;

/**
 * The string one binding is keyed by: its provider, scope, scope reference and server
 * name, encoded through the console's one tuple encoder so a separator inside a wire
 * string cannot make two bindings collide.
 */
export function mcpBindingKeyOf(binding: McpServerBindingRef): string {
  return structuralKey(
    binding.scope === "user"
      ? [binding.provider, binding.scope, binding.serverName]
      : [binding.provider, binding.scope, binding.scopeRef, binding.serverName],
  );
}

/** The default minter: the platform's own identifier source. */
export function mintIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Turn a binding's toggle press into a settled outcome.
 *
 * The binding travels back so this shell renders per-binding outcomes: one aggregate
 * verdict could not say WHICH row a result was about.
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
 * A trust grant binds at the daemon against the binding's current base configuration
 * and reaches no provider config, so its reply carries `daemon_enforced` and no live
 * results at all. That difference is rendered rather than smoothed away: the same
 * result shape carries both, and the surface says where a change took effect.
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
