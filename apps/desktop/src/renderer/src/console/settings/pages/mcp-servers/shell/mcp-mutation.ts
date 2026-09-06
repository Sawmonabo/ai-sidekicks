// The two governance mutations this shell sends, and the idempotency key it mints.
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
// control is offered, and the daemon's typed refusal renders in place. So this module
// has no precondition to check and no arm for "not allowed" — a refusal is a refusal
// like any other, and it arrives from the daemon rather than from a guess made here.

import { settleGrowthRead } from "../../../../bridge/index.js";
import type {
  ConsoleBridge,
  GrowthMcpBindingRef,
  GrowthMcpMutationResult,
} from "../../../../bridge/index.js";
import type { ConsoleRefusal } from "../../../../core/index.js";

/** How a mutation this shell sent has settled. */
export type McpMutationOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly binding: GrowthMcpBindingRef }
  | {
      readonly kind: "settled";
      readonly binding: GrowthMcpBindingRef;
      readonly result: GrowthMcpMutationResult;
    }
  | {
      readonly kind: "refused";
      readonly binding: GrowthMcpBindingRef;
      readonly refusal: ConsoleRefusal;
    };

/** The outcome a shell starts in and returns to. Shared so it has one spelling. */
export const IDLE_MCP_MUTATION: McpMutationOutcome = { kind: "idle" };

/** Mints the key one press carries. Injected so a test can drive a retry. */
export type IdempotencyKeyMinter = () => string;

/** The default minter: the platform's own identifier source. */
export function mintIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Turn a binding's toggle press into a settled outcome.
 *
 * The binding travels back on every arm because this shell renders per-binding
 * outcomes: a page holding one aggregate verdict could not say WHICH row a refusal
 * was about, and a governance surface where one row's refusal appears to belong to
 * another is worse than one that reported nothing.
 */
export async function setBindingEnabled(options: {
  readonly bridge: ConsoleBridge;
  readonly binding: GrowthMcpBindingRef;
  readonly enabled: boolean;
  readonly idempotencyKey: string;
}): Promise<McpMutationOutcome> {
  const { bridge, binding, enabled, idempotencyKey } = options;
  const settlement = await settleGrowthRead(
    bridge.growth.mcpSetEnabled({ ...binding, enabled, clientIdempotencyKey: idempotencyKey }),
  );
  return settlement.status === "served"
    ? { kind: "settled", binding, result: settlement.value }
    : { kind: "refused", binding, refusal: settlement };
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
  readonly bridge: ConsoleBridge;
  readonly binding: GrowthMcpBindingRef;
  readonly trusted: boolean;
  readonly idempotencyKey: string;
}): Promise<McpMutationOutcome> {
  const { bridge, binding, trusted, idempotencyKey } = options;
  const settlement = await settleGrowthRead(
    bridge.growth.mcpSetTrust({ ...binding, trusted, clientIdempotencyKey: idempotencyKey }),
  );
  return settlement.status === "served"
    ? { kind: "settled", binding, result: settlement.value }
    : { kind: "refused", binding, refusal: settlement };
}

/**
 * The string one binding is keyed by — its scope-qualified identity, spelled once.
 *
 * THE IDENTITY IS THE WHOLE TUPLE AND NEVER THE SERVER NAME. Two same-named servers in
 * two scopes are two bindings, and a surface that keyed on the name would put one row's
 * outcome on the other's control. `scopeRef` is read through the union's own arms
 * rather than through a cast, so a `user` binding contributes an empty segment rather
 * than a member its arm does not have.
 *
 * Here rather than beside the one component that maps over it, because the identity is
 * the mutation plane's own fact: the caller keys an outcome by it and the wire keys a
 * binding by it, and two spellings would drift the moment a scope axis moved.
 */
export function bindingOutcomeKey(binding: GrowthMcpBindingRef): string {
  const scopeRef = binding.scope === "user" ? "" : binding.scopeRef;
  return `${binding.provider} ${binding.scope} ${scopeRef} ${binding.serverName}`;
}
