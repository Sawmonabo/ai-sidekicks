// The structural guard an edit-and-resend is refused whole by, and what a person does about it.
//
// The reading is the daemon's own typed answer and nothing is derived: `rejectionGuard` is a
// closed discriminator on the rollback `rejected` arm, so this is a lookup, the renderer
// projects no eligibility of its own, and a new guard fails to compile here rather than
// reaching a person as silence.
//
// A rejection carrying no guard reads as the daemon's own cause, verbatim, with no move beside
// it; inventing a nearest guard for it would tell a person to fix something that is not wrong.

import type { RollbackCompositeRejectionGuard } from "@ai-sidekicks/contracts";

/** What one guard refused, and the act that clears it. */
export interface CompositeGuardReading {
  readonly guard: RollbackCompositeRejectionGuard;
  /** What this check refuses, in the console's words — never the daemon's cause. */
  readonly refused: string;
  /** The user's next move. */
  readonly remedy: string;
}

/** Every guard's reading, total over the contract's union so a new guard needs words. */
const COMPOSITE_GUARD_READINGS: Readonly<
  Record<RollbackCompositeRejectionGuard, Omit<CompositeGuardReading, "guard">>
> = {
  "user-authored-target": {
    refused:
      "The boundary you targeted was not opened by a user message of this run, so there is no user send to replace. A workflow phase input and an orchestrated child run both land here.",
    remedy:
      "Rewind to that boundary without a correction, and change the input where it was authored.",
  },
};

/**
 * What the daemon's guard means for the person who raised the request.
 *
 * `undefined` for a rejection that carries no guard, which is every refusal family but this
 * one.
 */
export function compositeGuardReading(
  rejectionGuard: RollbackCompositeRejectionGuard | undefined,
): CompositeGuardReading | undefined {
  if (rejectionGuard === undefined) {
    return undefined;
  }
  return { guard: rejectionGuard, ...COMPOSITE_GUARD_READINGS[rejectionGuard] };
}
