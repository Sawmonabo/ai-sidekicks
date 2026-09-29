// Why the daemon refused an edit and resend before anything went back, and what a person does
// about it.
//
// The guard is the daemon's own typed answer, so this is a lookup: the renderer decides no
// eligibility of its own, and a new guard fails to compile here rather than reaching a person
// as silence.
//
// A refusal carrying no guard reads as the daemon's own cause, verbatim, with no move beside
// it; inventing a nearest guard for it would tell a person to fix something that is not wrong.

import type { SessionResendRejectionGuard } from "@ai-sidekicks/contracts";

/** What one guard refused, and the act that clears it. */
export interface ResendGuardReading {
  readonly guard: SessionResendRejectionGuard;
  /** What this check refuses, in the console's words — never the daemon's cause. */
  readonly refused: string;
  /** The user's next move. */
  readonly remedy: string;
}

/** Every guard's reading, total over the contract's union so a new guard needs words. */
const RESEND_GUARD_READINGS: Readonly<
  Record<SessionResendRejectionGuard, Omit<ResendGuardReading, "guard">>
> = {
  "user-authored-target": {
    refused:
      "That message was not one you sent, so there are no words of yours to edit and resend. A workflow step's input and a message one agent sent another both land here.",
    remedy: "Edit the input where it was written, or edit a message you sent.",
  },
};

/**
 * What the daemon's guard means for the person who asked for the edit and resend.
 *
 * `undefined` for a refusal that carries no guard.
 */
export function resendGuardReading(
  rejectionGuard: SessionResendRejectionGuard | undefined,
): ResendGuardReading | undefined {
  if (rejectionGuard === undefined) {
    return undefined;
  }
  return { guard: rejectionGuard, ...RESEND_GUARD_READINGS[rejectionGuard] };
}
