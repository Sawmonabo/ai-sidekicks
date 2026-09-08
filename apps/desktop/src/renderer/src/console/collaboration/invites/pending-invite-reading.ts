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
 * Every other arm is terminal: joined, refused, authentication-FAILED whose reference
 * was released with the failure, the handle that stopped resolving, and the
 * acceptance that could not be put — the last two being what a prompt held open by
 * the ceremony above finally settles on, so five of the six are ends.
 *
 * A SWITCH RATHER THAN ONE EQUALITY, and that is the load-bearing part: the equality
 * this replaces absorbed every arm added after it into the terminal set silently,
 * which is exactly how a prompt comes to offer an act against an answer nobody
 * classified. A seventh arm fails to compile here instead.
 */
export function isInviteOutcomeInProgress(outcome: GrowthInviteOutcome): boolean {
  switch (outcome.kind) {
    case "authentication-required":
      return true;
    case "joined":
    case "refused":
    case "authentication-failed":
    case "reference-invalid":
    case "unavailable":
      return false;
  }
}

/**
 * Whether main is still holding the head's reference, so putting the card away has to
 * RELEASE it rather than merely clear the screen.
 *
 * THE QUESTION A CLOSE PATH ASKS, and it is not "has an answer arrived". Two states
 * answer yes: nothing has been dispatched yet, and an acceptance waiting on
 * authentication — which carries an outcome while main drives the ceremony and holds
 * the reference across it. Reading the outcome's mere PRESENCE as a spent reference
 * left that second state closable by a local acknowledgement the lifecycle then
 * refused, so the prompt went off screen with the ceremony and its reference still
 * outstanding and no surface left to back out from.
 *
 * ONE DEFINITION FOR THE CARD AND THE ARM ALIKE: the card routes Escape, the backdrop
 * and the control through it, and the arm decides by it whether to keep the dismissal
 * on screen. Two spellings of it are how a card comes to offer a control the
 * lifecycle will refuse, or refuse one it would have served.
 */
export function isInviteReferenceHeld(outcome: GrowthInviteOutcome | undefined): boolean {
  return outcome === undefined || isInviteOutcomeInProgress(outcome);
}

/**
 * Whether the answer already given admits the same act being put again.
 *
 * EXACTLY ONE ARM, AND THE WIRE DECIDES IT. An acceptance that never reached the
 * control plane settles `unavailable`, whose `retryable` is main's own statement that
 * nothing was decided and the act may be dispatched again; this reads that arm and
 * derives nothing. Whether the reference still resolves is main's answer to the
 * second act — `reference-invalid` where it does not — and never a judgement a
 * surface makes before sending.
 *
 * NOT THE PENDING RETRY, which re-drives a PREVIEW on an attempt handle and is read
 * off `PendingInviteSnapshot.canRetry`. The two authentication arms look retryable
 * and are neither: one is a ceremony still running and the other released its
 * reference with the failure.
 */
export function isInviteOutcomeReattemptable(outcome: GrowthInviteOutcome): boolean {
  return outcome.kind === "unavailable";
}
