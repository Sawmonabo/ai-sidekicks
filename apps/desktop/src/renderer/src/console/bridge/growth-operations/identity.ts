// The identity plane's ledger rows: which user this window is, and the
// session's callback-tool registry.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. The section
// comment below is the single table's own, kept with the rows it heads.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too. A hand-written list would be a
 * second copy of the id set — the thing `growth-entry.ts` exists to prevent.
 */
type IdentityOperationId = Extract<
  GrowthOperationId,
  "callerUserRead" | "callbackToolRegistryRead" | "userPresenceDetailRead"
>;

/** The identity rows, in the order the single table carried them. */
export const IDENTITY_GROWTH_OPERATIONS: Readonly<
  Record<IdentityOperationId, GrowthOperationEntry>
> = {
  // identity, and the callback-tool registry the approvals pane reads. Neither row
  // registers a method string anywhere, so neither entry names one — the corpus has
  // the daemon RESOLVE a caller's principal and never return it, and has the
  // callback-tool registry ride spawn with no read seam at all.
  callerUserRead: op("callerUserRead", "caller-user-identity", "method"),
  callbackToolRegistryRead: op("callbackToolRegistryRead", "callback-tool-registry-read", "method"),
  // The per-device fan-out behind the aggregated presence summary. It DOES name a
  // registered method — the `user.*` registry carries it — and it is the one
  // read whose refusal is specified as a projection rather than as an error: a device
  // the user has not linked gets the summary it already had.
  userPresenceDetailRead: op(
    "userPresenceDetailRead",
    "user-presence-detail",
    "method",
    "user.presenceDetail",
  ),
};
