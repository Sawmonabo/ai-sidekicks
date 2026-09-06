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

import type { ConsoleRefusal } from "../../core/index.js";
import type { InvitesListOutcome, ServedInvite } from "../../bridge/index.js";

/**
 * What this surface holds for one `invitesList` call: the port's answer, or why
 * there is none.
 *
 * The port's contract is that it RESOLVES with a `GrowthOutcome` — served, or
 * `unavailable` with the reason on it — so the ordinary refusal already travels
 * inside the outcome. A REJECTION is a different fact: the call produced no outcome
 * at all, and the outcome union has no member for it, because its refusal arm
 * carries a closed code vocabulary the growth port owns and this console does not.
 *
 * A cell holding only the outcome therefore had one arm too few, and the missing arm
 * is the one that matters most: a `.then` with no rejection handler leaves the cell
 * untouched, so the ledger goes on saying "Reading this session's invitations" for
 * the life of the window while an unhandled rejection reaches it — a read that
 * FAILED reported as a read still IN FLIGHT, which is the conflation the console's
 * kinds of nothing exist to prevent.
 *
 * Concrete rather than generic, and family-local: every view family is a sibling of
 * every other, so the shape cannot be shared from here. The settings family holds
 * the same two arms for its own one-shot reads, and the home both could share is
 * `bridge/`, beside `GrowthOutcome` itself.
 */
export type LedgerReading =
  | { readonly kind: "answered"; readonly outcome: InvitesListOutcome }
  | { readonly kind: "unreadable"; readonly refusal: ConsoleRefusal };

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
 * Returns the reading it was given, by identity, when there is nothing to change —
 * a read that produced no outcome, a refused read, a read still in flight, or a
 * settlement naming a row this ledger never held. Identity rather than a fresh equal
 * object so a surface holding it in state re-renders only when the ledger moved.
 */
export function withSettledInvite(
  reading: LedgerReading | undefined,
  settlement: InviteRevokeResponse,
): LedgerReading | undefined {
  if (reading === undefined || reading.kind !== "answered") {
    return reading;
  }
  const { outcome } = reading;
  if (outcome.status !== "served") {
    return reading;
  }
  let didNameAHeldRow = false;
  const settledRows = outcome.value.map((invite) => {
    if (invite.inviteId !== settlement.inviteId) {
      return invite;
    }
    didNameAHeldRow = true;
    return { ...invite, state: settlement.state };
  });
  return didNameAHeldRow
    ? { kind: "answered", outcome: { ...outcome, value: settledRows } }
    : reading;
}
