// What a surface reads off the deep-link lifecycle, and the one question it asks of
// an answer already given.
//
// SPLIT FROM `pending-invite.ts` on the line `bridge/queue/queue-reading.ts` draws
// beside `bridge/queue/queue-subscription.ts`: that file is the machine — feeds, a
// latch, a scheduler, a teardown — and this is the shape it publishes. Two surfaces
// and two suites take this value, and none of them opens a feed to get it.
//
// EVERY MEMBER IS A PROJECTION OF ONE STATE. The lifecycle holds one queue of
// arrivals and one table of answers; what is below is those two read from a surface's
// point of view, so nothing here is a second copy of anything and no consumer can
// find the two disagreeing.

import type {
  GrowthInviteOutcome,
  GrowthPendingInvite,
  GrowthPendingInvitePreviewFailure,
} from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";

/** What one act on the head's own handle can be waiting on. */
export type PendingInviteAct = "confirm" | "retry" | "dismiss";

/** What a surface renders. Recomputed only when something below actually moved. */
export interface PendingInviteSnapshot {
  /**
   * The head, where it is the one arm that can be confirmed.
   *
   * `undefined` where nothing is waiting AND where what is waiting is a preview that
   * refused or could not be put — those reach a surface through {@link previewFailure}
   * instead, because they carry no reference, no session and no expiry, and a card
   * that rendered them through this member would be rendering facts it was not given.
   */
  readonly invite: GrowthPendingInvite | undefined;
  /**
   * The head, where it is a preview that produced nothing to confirm.
   *
   * Mutually exclusive with {@link invite} rather than a second copy of it: both are
   * projections of one head, split at the boundary a surface already draws, so at
   * most one of the two is ever defined.
   */
  readonly previewFailure: GrowthPendingInvitePreviewFailure | undefined;
  /** Arrivals behind the head. Rendered as a count, never as a second card. */
  readonly waitingBehind: number;
  /**
   * Whether the bound turned an arrival away that has not been brought back yet.
   *
   * Never silent: the queue is bounded, so a burst past it is deferred rather than
   * held, and this says so until the replay `core/constants.ts` names has re-delivered
   * what main is still holding.
   */
  readonly hasDeferredArrivals: boolean;
  /** How the head's own attempt ended, once one has. */
  readonly outcome: GrowthInviteOutcome | undefined;
  /**
   * Whether the head is a preview that can be put again.
   *
   * The one state a retry helps, and the only one carrying the attempt handle a retry
   * is dispatched on. Never true of an answer already given: see
   * {@link isInviteOutcomeInProgress} for the difference the two authentication arms
   * draw, neither of which is this.
   */
  readonly canRetry: boolean;
  /** The act in flight on the head, if any. Nothing else may be dispatched. */
  readonly actInFlight: PendingInviteAct | undefined;
  /** An act that the port refused. Cleared by the next act on the same head. */
  readonly actRefusal: ConsoleRefusal | undefined;
  /** A feed that was reached and broke. The unbuilt-wire case is deliberately absent. */
  readonly feedRefusal: ConsoleRefusal | undefined;
}

/** A window with no invitation waiting and no channel trouble to report. */
export const EMPTY_PENDING_INVITE_SNAPSHOT: PendingInviteSnapshot = {
  invite: undefined,
  previewFailure: undefined,
  waitingBehind: 0,
  hasDeferredArrivals: false,
  outcome: undefined,
  canRetry: false,
  actInFlight: undefined,
  actRefusal: undefined,
  feedRefusal: undefined,
};

/**
 * Whether an outcome is a step still running rather than an answer.
 *
 * EXACTLY ONE ARM. An acceptance waiting on authentication has main driving a
 * ceremony and holding the reference across it, so the prompt stays open and offers
 * neither a second attempt nor a way to put the answer away — there is no answer yet.
 * Every other arm is terminal: joined, refused, and authentication-FAILED, whose
 * reference was released with the failure, which is what makes it an end and not a
 * pause.
 *
 * NO ARM OFFERS A RETRY, which is why no predicate here says one does. Trying again
 * means putting a preview to the control plane again, and that is a property of the
 * pending state a person is looking at rather than of an answer already given —
 * `PendingInviteSnapshot.canRetry` is where it is read.
 */
export function isInviteOutcomeInProgress(outcome: GrowthInviteOutcome): boolean {
  return outcome.kind === "authentication-required";
}
