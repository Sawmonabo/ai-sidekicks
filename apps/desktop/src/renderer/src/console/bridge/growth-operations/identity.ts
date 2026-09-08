// The identity plane's ledger rows: which participant this window is, and the
// session's callback-tool registry.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. The section
// comment below is the single table's own, kept with the rows it heads — including
// the standing statement that no participant-role row will join them.

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
  | "callerParticipantRead"
  | "callbackToolRegistryRead"
  | "membershipRosterRead"
  | "participantPresenceDetailRead"
>;

/** The identity rows, in the order the single table carried them. */
export const IDENTITY_GROWTH_OPERATIONS: Readonly<
  Record<IdentityOperationId, GrowthOperationEntry>
> = {
  // identity, and the callback-tool registry the approvals pane reads. Neither row
  // registers a method string anywhere, so neither entry names one — the corpus has
  // the daemon RESOLVE a caller's principal and never return it, and has the
  // callback-tool registry ride spawn with no read seam at all.
  //
  // THERE IS NO `participant-role-read` ROW, AND THERE WILL NOT BE ONE. The role is
  // a lookup, not a read: `store/selectors.ts`'s `membershipRoleOf` answers it from
  // the roster this session's own store already holds, and `store/hooks.ts`'s
  // `useCallerMembershipRole` chains this operation to it. A slate row for the role
  // would be asking a second wire for a fact a shipped partition owns, and the two
  // could disagree with nothing able to say which was right.
  callerParticipantRead: op(
    "callerParticipantRead",
    "caller-participant-identity",
    "method",
    "read which of a session's participants this window is, so a members surface can address the sender and an approvals control can resolve the caller's own role rather than treating an unread one as read-only",
  ),
  callbackToolRegistryRead: op(
    "callbackToolRegistryRead",
    "callback-tool-registry-read",
    "method",
    "read the callback tools registered into a session, so the approvals pane can name what an agent may call rather than only what it has already been seen calling",
  ),
  // The membership roster, which names no wire method because none is registered:
  // every shape that carries a `membershipId` answers a JOIN or a WRITE, so a window
  // that neither created nor joined the session in this process holds an identifier
  // for no membership but its own — and the four `membership.update` controls are
  // keyed by exactly that identifier.
  membershipRosterRead: op(
    "membershipRosterRead",
    "membership-roster-read",
    "method",
    "read a membershipId beside each of a session's participants, so the membership controls are reachable on a session this window did not create",
  ),
  // The per-device fan-out behind the aggregated presence summary. It DOES name a
  // registered method — the `participant.*` registry carries it — and it is the one
  // read whose refusal is specified as a projection rather than as an error: a caller
  // outside the owner/operator set gets the summary they already had.
  participantPresenceDetailRead: op(
    "participantPresenceDetailRead",
    "participant-presence-detail",
    "method",
    "read one participant's per-device presence fan-out, which is the detail the roster's density rule promises one hover away and which no registered reply carries today",
    "participant.presenceDetail",
  ),
};
