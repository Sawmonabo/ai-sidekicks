// The four structural guards an edit-and-resend is refused whole by, and what a
// person does about each.
//
// An edit-and-resend is refused whole by four checks, each fail-closed at admission and
// pre-dispatch: no active turn, no pending send, a participant-authored target of this
// run, and a resumable target. Each refuses for a different reason and each leaves the
// participant a different next move, and until this reading existed the console showed
// one wire string and no move at all — which is worst for the pending-send guard, whose
// remedy is an act the person has to perform (cancel the queued items, or let them
// drain) before the same request can ever succeed.
//
// IT IS THE DAEMON'S OWN TYPED ANSWER AND NOTHING IS DERIVED. `rejectionGuard` is the
// closed four-value discriminator on the rollback `rejected` arm
// (`packages/contracts/src/runControl.ts`), producer-obligated: a refusal raised by
// one of the four guards always populates it and every other refusal family never
// does. So the reading is a lookup, the renderer projects no eligibility of its own,
// and a fifth guard fails to compile here rather than reaching a person as silence.
//
// WHAT THIS REPLACED, AND WHY THE REPLACEMENT IS NOT COSMETIC. This module used to
// recognise a guard by matching phrases inside `rejectionReason`, which is registered
// as a free-form `string` with no vocabulary any contract publishes — so the match
// was against a value set that does not exist. Two failures followed from that and
// both are real: a daemon supplying an exact typed guard beside a cause whose wording
// carried none of the phrases got no remedy at all, and a cause naming two of them
// answered nothing because containment cannot rank two matches. Neither case can
// arise over a closed discriminator, so the phrase table is deleted rather than kept
// beside this — two answers to "which guard refused" is exactly the drift this
// family refuses everywhere else.
//
// AND A REJECTION CARRYING NO GUARD READS EXACTLY AS IT DOES WITHOUT THIS: the
// daemon's own cause, verbatim, with no move beside it. That is the honest result
// for a refusal that is not one of these four — a bare rollback's
// `driver.capability_unsupported` among them — and inventing a nearest guard for it
// would be the console telling a person to drain a queue that has nothing in it.

import type { RollbackCompositeRejectionGuard } from "@ai-sidekicks/contracts";

/** What one guard refused, and the act that clears it. */
export interface CompositeGuardReading {
  readonly guard: RollbackCompositeRejectionGuard;
  /** What this check refuses, in the console's words — never the daemon's cause. */
  readonly refused: string;
  /** The participant's next move, which for two of the four is a real act. */
  readonly remedy: string;
}

/**
 * Every guard's reading, TOTAL over the contract's own union.
 *
 * A `Record` over the closed type rather than a list with a discriminator, so the
 * table is exhaustive by construction: a fifth guard registered in
 * `packages/contracts` fails to compile here until it is given its words and its
 * move.
 */
const COMPOSITE_GUARD_READINGS: Readonly<
  Record<RollbackCompositeRejectionGuard, Omit<CompositeGuardReading, "guard">>
> = {
  "no-active-turn": {
    refused:
      "The run is still answering the message you corrected. The rewind was refused outright rather than pausing a live turn to rewrite the prompt it is working from.",
    remedy: "Pause or stop the run first, then correct the message again.",
  },
  "no-pending-send": {
    refused:
      "An earlier send is still pending on this run — accepted and not yet delivered, or queued and not yet drained — and it would reach the provider ahead of your correction.",
    remedy:
      "Cancel the queued items, or let them drain, and then send the correction again. Nothing here reorders the queue on your behalf.",
  },
  "participant-authored-target": {
    refused:
      "The boundary you targeted was not opened by a participant message of this run, so there is no participant send to replace. A workflow phase input and an orchestrated child run both land here.",
    remedy:
      "Rewind to that boundary without a correction, and change the input where it was authored.",
  },
  "resumable-target": {
    refused:
      "This run can never resume — its execution context is released with no working root — so a correction queued against it would never be delivered.",
    remedy:
      "Rewind without a correction to keep the history, then start a fresh run on the same branch carrying the corrected text.",
  },
};

/**
 * What the daemon's guard means for the person who raised the request.
 *
 * `undefined` for a rejection that carries no guard, which is every refusal family
 * but these four — the whole of what the console can honestly say about a refusal
 * the wire did not attribute to one of them.
 */
export function compositeGuardReading(
  rejectionGuard: RollbackCompositeRejectionGuard | undefined,
): CompositeGuardReading | undefined {
  if (rejectionGuard === undefined) {
    return undefined;
  }
  return { guard: rejectionGuard, ...COMPOSITE_GUARD_READINGS[rejectionGuard] };
}
