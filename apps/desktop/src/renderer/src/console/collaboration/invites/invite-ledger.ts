// The sent-invite ledger's model: which half a row belongs in, and what a settled
// revocation does to the one it names.
//
// A module rather than four helpers inside the view, because the whole question is
// a fold over a wire reply and the view's job is only to draw it. It holds no state
// and reaches no bridge: every function here takes the outcome the surface is
// holding and answers with the outcome it should hold next.
//
// A SETTLED REVOKE NEEDS NO SECOND READ, AND THAT IS THE REPLY'S DOING. `invite.revoke`
// answers `{inviteId, state}` — the row's own identifier and its new lifecycle state,
// which are exactly the two fields that decide which half of this ledger a row sits
// in. So the reply IS the authoritative projection of the row that changed, and the
// ledger consumes it. A re-read through the refresh chokepoint would ask the daemon a
// question it has already answered in the same round trip, and `invitesList` is a
// growth-port row the live bridge refuses anyway — so the re-read would replace a
// settled row with a refusal.
//
// NOTHING IS APPLIED BEFORE THE CALL RETURNS. The state written here is the state the
// daemon sent back, never the state the console expected: a revoke that settles as
// something other than `revoked` renders as whatever the daemon actually said.

import type { InviteRevokeResponse } from "@ai-sidekicks/contracts";

import type { InvitesListOutcome, ServedInvite } from "../../bridge/index.js";

/** Pending first, then everything that has already settled. */
export interface InviteLedger {
  readonly pending: readonly ServedInvite[];
  readonly settled: readonly ServedInvite[];
}

export function partitionInvites(invites: readonly ServedInvite[]): InviteLedger {
  return {
    pending: invites.filter((invite) => invite.state === "pending"),
    settled: invites.filter((invite) => invite.state !== "pending"),
  };
}

/**
 * The ledger this outcome becomes once the daemon has settled one invitation.
 *
 * Returns the outcome it was given, by identity, when there is nothing to change —
 * a refused read, a read still in flight, or a settlement naming a row this ledger
 * never held. Identity rather than a fresh equal object so a surface holding it in
 * state re-renders only when the ledger actually moved.
 */
export function withSettledInvite(
  outcome: InvitesListOutcome | undefined,
  settlement: InviteRevokeResponse,
): InvitesListOutcome | undefined {
  if (outcome === undefined || outcome.status !== "served") {
    return outcome;
  }
  let didNameAHeldRow = false;
  const settledRows = outcome.value.map((invite) => {
    if (invite.inviteId !== settlement.inviteId) {
      return invite;
    }
    didNameAHeldRow = true;
    return { ...invite, state: settlement.state };
  });
  return didNameAHeldRow ? { ...outcome, value: settledRows } : outcome;
}
