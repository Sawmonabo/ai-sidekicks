// How this family says an account-plane reading could not be taken.
//
// Split from `provider-account-quota.ts` for the reason `queue-refusals.ts` was split
// from the reading beside it, and the two files are deliberately the same shape:
// composing a refusal and holding a registry are two jobs, and both sentences here
// are pure functions of what failed, so they are testable without a bridge and
// readable without the fold.
//
// The ORIGIN lives here rather than beside either reader because three modules now
// raise refusals in this subsystem's name — the wire, the tail, and this file — and a
// constant declared beside one of them would make the other two import through it.

import {
  normalizeWireRejection,
  refuse,
  refusedMemberPaths,
  type ConsoleRefusal,
} from "../core/index.js";
import type { UnreadableDeliveryIssues } from "./unreadable-deliveries.js";

/** The subsystem name every refusal the account-plane reading raises carries. */
export const PROVIDER_QUOTA_REFUSAL_ORIGIN = "provider-account-quota";

/**
 * The refusal an unopenable stream settles as.
 *
 * The console's ONE reading of a rejected promise, consumed rather than re-derived:
 * `normalizeWireRejection` unwraps a carried refusal structurally — which keeps the
 * subscription wrapper's own code intact rather than replacing it with this
 * subsystem's — and reads a typed envelope's dotted code off `data.type`, where a
 * `{ code: string }` guard cannot see it. All this module supplies is the origin.
 *
 * NO FALLBACK PAIR, on the queue family's rule next door: a stream that would not
 * open failed for a transport reason the transport itself states, and a house
 * sentence would displace the one diagnosis a person can act on.
 */
export function streamRefusalFor(rejection: unknown): ConsoleRefusal {
  return normalizeWireRejection(PROVIDER_QUOTA_REFUSAL_ORIGIN, rejection);
}

/**
 * One unreadable delivery as the refusal a surface renders.
 *
 * Names the failing MEMBER PATHS and never the payload: the payload is a frame this
 * build could not read, so quoting it would put an unbounded and unvalidated value on
 * screen to explain why an unvalidated value was refused. The path set is fixed by
 * the registered union, which is what bounds the sentence without a cap to spend.
 */
export function unreadableDeliveryRefusal(issues: UnreadableDeliveryIssues): ConsoleRefusal {
  return refuse(
    PROVIDER_QUOTA_REFUSAL_ORIGIN,
    "delivery-unreadable",
    `A provider-account delivery did not match the registered notification shape, so it moved no account or quota here: ${refusedMemberPaths(issues).join(", ")}.`,
  );
}
