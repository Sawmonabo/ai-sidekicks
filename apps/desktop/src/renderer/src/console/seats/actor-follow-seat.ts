// The follow seat: how the cast bar asks the ledger to bring an actor into view.
//
// A cast chip is a control that follows the actor — this family's own reading of the
// cast bar, resolved over the log by `workspace/actor-follow.ts`, which no committed
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
// means no ledger is mounted in this window, which is a thing to say rather than a
// press that does nothing.

import { SingleSlotSeat } from "./single-slot-seat.js";

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

const actorFollowSeat = new SingleSlotSeat<ActorFollowHandler>(
  "actor follow",
  "one ledger scrolls per window; a second owner would make which one moves depend on import order",
);

/** The call the family that renders the ledger makes to fill the seat. */
export function registerActorFollowHandler(owner: string, handle: ActorFollowHandler): void {
  actorFollowSeat.register({ owner, render: handle });
}

/**
 * Release the seat.
 *
 * Test scaffolding, and named as such: the seat is module-scope, so a case that
 * fills it would leak into the next one.
 */
export function unregisterActorFollowHandler(): void {
  actorFollowSeat.unregister();
}

/** The registered handler, or `undefined` while no ledger has filled the seat. */
export function actorFollowHandler(): ActorFollowHandler | undefined {
  return actorFollowSeat.renderer();
}
