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
   * held, and this says so until the replay `core/constants/invite-caps.ts` names has re-delivered
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
 * What main is doing with the reference an answer names.
 *
 * THE ONE CLOSED READING OF THAT UNION, AND EVERY QUESTION BELOW DERIVES FROM IT. Four
 * surfaces ask something about an outcome — whether the prompt may be closed at all,
 * what closing it MEANS, whether a second attempt is offered, and which control row is
 * drawn — and each of them used to switch, or worse compare, over the arms on its own.
 * Three answers to one classification is how `unavailable` came to be read as an end:
 * it is terminal for the REPORT, which has words to draw and a retry to offer, and it
 * is not terminal for the REFERENCE, which main is still holding because the
 * acceptance never reached the control plane. A predicate that fused the two put the
 * card away and released nothing, so the invitation came back on the next replay and
 * the reference sat allocated until its TTL.
 *
 * THREE ARMS BECAUSE THE UNION SPLITS THREE WAYS, and no pair of them can be collapsed:
 *
 *   • `awaiting` — main is driving a ceremony and holds the reference across it. There
 *     is no answer yet, so nothing may be acknowledged and nothing may be re-attempted.
 *   • `retryable` — nothing was decided and main still holds the reference, so the act
 *     may be put again AND putting the prompt away has to release it over the wire.
 *   • `spent` — main holds nothing: the acceptance was consumed, refused, failed its
 *     ceremony, or the handle stopped resolving. Closing is local by construction.
 *
 * A SWITCH RATHER THAN AN EQUALITY, and that is the load-bearing part: an equality
 * absorbs every arm added after it into whichever set it defaulted to, which is exactly
 * how a prompt comes to offer an act against an answer nobody classified. Exhaustive by
 * the declared return type — a seventh arm leaves a path that returns nothing and fails
 * to compile here, in the one place the union is read.
 */
export type InviteReferenceDisposition = "awaiting" | "retryable" | "spent";

export function inviteReferenceDisposition(
  outcome: GrowthInviteOutcome,
): InviteReferenceDisposition {
  switch (outcome.kind) {
    case "authentication-required":
      return "awaiting";
    case "unavailable":
      return "retryable";
    case "joined":
    case "refused":
    case "authentication-failed":
    case "reference-invalid":
      return "spent";
  }
}

/**
 * Whether an outcome is a step still running rather than an answer.
 *
 * EXACTLY ONE ARM. An acceptance waiting on authentication has main driving a
 * ceremony and holding the reference across it, so the report offers neither a second
 * attempt nor a way to put the answer away — there is no answer yet. Every other arm
 * has something to say and something to press.
 */
export function isInviteOutcomeInProgress(outcome: GrowthInviteOutcome): boolean {
  return inviteReferenceDisposition(outcome) === "awaiting";
}

/**
 * Whether main is still holding the head's reference, so putting the card away has to
 * RELEASE it rather than merely clear the screen.
 *
 * THE QUESTION A CLOSE PATH ASKS, and it is not "has an answer arrived" — nor even
 * "is one still coming". THREE states answer yes: nothing has been dispatched yet, an
 * acceptance waiting on authentication, and an acceptance that never reached the
 * control plane, whose `retryable` is the wire saying in as many words that the act
 * may be put again. That last one is why this is not {@link isInviteOutcomeInProgress}
 * with an `undefined` arm bolted on: it is an ANSWER — the report draws it and offers
 * a retry against it — and the reference behind it is still main's.
 *
 * ONE DEFINITION FOR THE CARD AND THE LIFECYCLE ALIKE: the card routes Escape, the
 * backdrop and the close control through it, and the adapter refuses a LOCAL release
 * by it. Two spellings of it are how a card comes to offer a control the lifecycle
 * will refuse, or release a handle the daemon still has.
 */
export function isInviteReferenceHeld(outcome: GrowthInviteOutcome | undefined): boolean {
  return outcome === undefined || inviteReferenceDisposition(outcome) !== "spent";
}

/**
 * Whether the card is still waiting for the answer it will report.
 *
 * WHICH CONTROL ROW IS DRAWN, and deliberately a different question from the one
 * above. Before an answer exists — and while one is still running — the card's own
 * act row carries the close; once an answer has arrived the report carries it, because
 * the report is what a person is reading at that point. `unavailable` is the arm that
 * separates the two: it is an answer with words and a retry, so the report draws its
 * row, and main still holds its reference, so that row's close is a dismissal.
 *
 * Collapsing the two questions is what drew two close controls at once on that arm —
 * one act offered twice, which the card's whole shape forbids.
 */
export function isInviteAnswerOutstanding(outcome: GrowthInviteOutcome | undefined): boolean {
  return outcome === undefined || inviteReferenceDisposition(outcome) === "awaiting";
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
  return inviteReferenceDisposition(outcome) === "retryable";
}
