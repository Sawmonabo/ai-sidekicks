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

import { refuse, refusedMemberPaths, type ConsoleRefusal } from "../../core/index.js";
import type { UnreadableDeliveryIssues } from "../readings/index.js";

/** The subsystem name every refusal the account-plane reading raises carries. */
export const PROVIDER_QUOTA_REFUSAL_ORIGIN = "provider-account-quota";

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
