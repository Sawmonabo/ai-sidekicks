// The follow seat: how the cast bar asks the ledger to bring an actor into view.
//
// A cast chip is a control that follows the actor — this family's own reading of the
// cast bar, resolved over the log by `workspace/cast-bar/actor-follow.ts`, which no committed
// document states. That has two halves and they belong to two families. The deck's
// half — focus the actor's pane, or the session's ledger — is the workspace's and
// happens where the deck lives. The ledger's half — scroll that actor's latest row
// into view — belongs to whichever family renders the ledger, because the row's
// identity comes from the ledger's own projection and the scroll goes through the
// ledger's own chokepoint. The workspace holds neither.
//
// So the request travels as a SEAT rather than as an import, like every other thing
// two view families hand each other here. What crosses is what the workspace can
// honestly say: which participant, and the log position of that participant's newest
// row. Not a row id — row identity is minted by the ledger's projection, and a second
// derivation of it in this family would be the drift the seats rule exists to stop.
//
// The seat's absence is a real state and the caller renders it. An unfilled seat
// means no ledger is mounted in that pane, which is a thing to say rather than a
// press that does nothing.
//
// KEYED BY PANE, AND THAT IS THE WHOLE DESIGN. A deck holds a session log beside a
// channel-scoped one whenever somebody opens both, and each is a different window
// over a different set of rows. A single slot made "which ledger scrolls" a fact
// about mount order: the caller focused one pane and the other one moved, or reported
// that the row was not in view because the occupant was scoped to a channel the row
// is not in. So the caller names the pane it focused, and the ledger in THAT pane
// answers — or nothing does, which is the honest absence.
//
// The key is the pane and the owner is still the family, so the two properties that
// made this a seat both survive: the same family re-registering a pane is ordinary
// (a re-render, a hot reload), and a second family claiming a pane the ledger already
// fills is refused by name rather than silently deciding which body moves.

import { KeyedRegistry } from "../core/index.js";

/** Which actor to follow, and where their newest row sits in the session log. */
export interface ActorFollowRequest {
  readonly participantId: string;
  /**
   * The `sequence` of that participant's newest event.
   *
   * Wire-verbatim and monotonic within the session, so the ledger can resolve it to
   * its own row without this family knowing how a row is keyed.
   */
  readonly newestSequence: number;
}

/**
 * What the ledger did with the request.
 *
 * A returned outcome rather than a void call, because the caller has to say
 * something when the row could not be brought into view — a chip press that
 * silently does nothing is the defect this seat was added to end.
 */
export type ActorFollowOutcome = "revealed" | "row-not-in-view";

export type ActorFollowHandler = (request: ActorFollowRequest) => ActorFollowOutcome;

/** What one pane's claim holds: who filled it, and how that pane scrolls. */
interface ActorFollowClaim {
  readonly owner: string;
  readonly scrollTo: ActorFollowHandler;
}

const actorFollowSeats = new KeyedRegistry<string, ActorFollowClaim>({
  duplicatePolicy: "owner-scoped",
  describeWhat: "actor follow seat",
  ownerOf: (claim) => claim.owner,
  duplicateHint:
    "one ledger scrolls per pane; a second owner would make which body moves depend on import order",
});

/** The one owner string every ledger claim carries. Two panes, one family. */
const LEDGER_FOLLOW_SEAT_OWNER = "ledger";

/**
 * The call the family that renders the ledger makes to fill one pane's seat.
 *
 * Re-registering the same pane REPLACES the handler rather than refusing it, which
 * is the owner-scoped policy doing its own job: the owner is the family, the family
 * is the same one every time, and a remount is not a conflict. A different family
 * claiming a pane this one fills still throws, which is the property that makes this
 * a seat rather than a map.
 */
export function registerActorFollowHandler(paneId: string, scrollTo: ActorFollowHandler): void {
  actorFollowSeats.register(paneId, { owner: LEDGER_FOLLOW_SEAT_OWNER, scrollTo });
}

/**
 * Release one pane's seat.
 *
 * Called on unmount, and by a test that filled it: the registry is module-scope, so
 * a case that left a claim behind would leak into the next one.
 */
export function unregisterActorFollowHandler(paneId: string): void {
  actorFollowSeats.unregister(paneId);
}

/** That pane's handler, or `undefined` while no ledger is mounted in it. */
export function actorFollowHandler(paneId: string): ActorFollowHandler | undefined {
  return actorFollowSeats.get(paneId)?.scrollTo;
}
