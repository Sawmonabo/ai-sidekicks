// How an attempt on one invitation ended, in six readings.
//
// SIX ARMS RATHER THAN TWO, and the split is the whole reason this exists. The
// shipped acceptance path settles resolved-or-rejected, which reads an authentication
// detour and a control-plane refusal as one event — and they are opposites: one is a
// step the person is still taking, the other is a door that is shut. So the two
// authentication arms carry their own reading rather than a refusal's copy, and so do
// the two that are about the HANDLE rather than the invitation: a reference that
// stopped resolving, and an acceptance that never reached the control plane at all.
//
// A SWITCH RATHER THAN A TERNARY CHAIN, and that is load-bearing rather than tidy.
// The chain this replaces ended in an `else` that rendered the authentication
// reading, so an arm added to the union arrived on screen wearing another arm's
// words with nothing failing. The switch below is total, and a seventh arm fails to
// compile here.
//
// EXACTLY ONE ARM OFFERS A SECOND ATTEMPT, and it is not either of the two that look
// as though they should. An acceptance waiting on authentication is IN PROGRESS: main
// is driving the ceremony and holding the reference across it, so the answer is still
// coming and a second act would race it. One that FAILED authentication is terminal
// and its reference was released with the failure, so a second act would send a spent
// handle. What DOES admit one is the acceptance that could not be put: nothing was
// decided, the wire says so with `retryable`, and the act put again is the same
// confirmation on the same reference — main answers `reference-invalid` where the
// handle has since stopped resolving, which is what makes offering it safe. Both
// predicates are the lifecycle's, in `pending-invite-reading.ts`, and are consulted
// rather than re-derived here.
//
// THE PENDING RETRY IS A DIFFERENT ACT and lives nowhere near this file: it re-drives
// a PREVIEW on an attempt handle, which is a property of a pending state rather than
// of an answer already given.
//
// THE IN-PROGRESS ARM DRAWS NO ROW AT ALL. There is no answer to put away yet, and a
// prompt cleared before its terminal arrives strands that answer against an invitation
// this window no longer holds — so the one act offered there is the close the card's
// own act row keeps, which on that arm releases the reference over the wire.
//
// AND WHAT THE CLOSE DOES IS NOT THIS COMPONENT'S TO DECIDE. **Done** puts the prompt
// away; whether that is a local acknowledgement or the wire act that releases a
// reference main is still holding is resolved once, by the card, from the arm. The
// `unavailable` arm is why that matters here: it is an answer with words and a retry,
// so this row draws it, and the acceptance it reports never reached the control plane
// — so main still holds the handle and **Done** has to release it.
//
// NOTHING HERE DISPATCHES ANYTHING. Every act is a callback the owner supplies, so
// this is a pure reading of one value and a suite renders all six arms without a
// bridge.

import type { GrowthInviteOutcome } from "../../bridge/index.js";
import { InviteAcceptanceUnavailableReading } from "./InviteAcceptanceUnavailableReading.js";
import { InviteAuthenticationReading } from "./InviteAuthenticationReading.js";
import { InviteJoinedReading } from "./InviteJoinedReading.js";
import { InviteReferenceInvalidReading } from "./InviteReferenceInvalidReading.js";
import { InviteRefusedReading } from "./InviteRefusedReading.js";
import {
  isInviteOutcomeInProgress,
  isInviteOutcomeReattemptable,
} from "./pending-invite-reading.js";

export interface InviteOutcomeReportProps {
  readonly outcome: GrowthInviteOutcome;
  /**
   * Put the acceptance to the control plane again, on this same reference.
   *
   * THE SAME ACT THE CARD ALREADY OFFERS BEFORE AN ANSWER, deliberately: an
   * acceptance that could not be put is one that never happened, so what answers it
   * is the confirmation rather than a second control with a second meaning. Offered
   * only where the reading says the arm admits it.
   */
  readonly onConfirm: () => void;
  /**
   * Put this result away — the card's one close act, already resolved.
   *
   * Local where the reference is spent and the wire's dismissal where main still holds
   * it. This row draws the control and never chooses between the two.
   */
  readonly onClose: () => void;
  /** True while an act on this reference is unsettled, so a second is not offered. */
  readonly isActing: boolean;
}

export function InviteOutcomeReport(props: InviteOutcomeReportProps): React.JSX.Element {
  const { outcome } = props;
  return (
    <section className="meridian-invite-outcome" aria-label="How this invitation ended">
      {outcomeBody(outcome)}

      {/* The in-progress predicate is the lifecycle's, consulted rather than
          re-derived: which answers are still running is a property of the machine,
          and a component deciding it separately would be a second answer that goes
          stale the first time an arm is added. The whole act row goes with it — a
          prompt with nothing to acknowledge yet has no controls at all, and drawing a
          disabled one would suggest an answer is available to put away. */}
      {isInviteOutcomeInProgress(outcome) ? null : (
        <div className="meridian-invite-outcome__acts">
          <button
            type="button"
            className="meridian-invite-outcome__acknowledge"
            disabled={props.isActing}
            onClick={props.onClose}
          >
            Done
          </button>
          {/* Second in the row, behind the act that sends nothing — the card's
              ordering rule applied to an answer: a stray press puts the prompt away
              rather than putting a request back on the wire. */}
          {isInviteOutcomeReattemptable(outcome) ? (
            <button
              type="button"
              className="meridian-invite-outcome__retry"
              disabled={props.isActing}
              aria-busy={props.isActing}
              onClick={props.onConfirm}
            >
              {props.isActing ? "Trying…" : "Try again"}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * The words for one arm.
 *
 * Total over the union, which is what the ternary chain this replaces was not: every
 * arm names its own reading, and an arm added without one fails to compile rather
 * than falling through to whichever branch happened to be last.
 */
function outcomeBody(outcome: GrowthInviteOutcome): React.JSX.Element {
  switch (outcome.kind) {
    case "joined":
      return <InviteJoinedReading outcome={outcome} />;
    case "refused":
      return <InviteRefusedReading outcome={outcome} />;
    case "reference-invalid":
      return <InviteReferenceInvalidReading outcome={outcome} />;
    case "unavailable":
      return <InviteAcceptanceUnavailableReading />;
    case "authentication-required":
    case "authentication-failed":
      return <InviteAuthenticationReading outcome={outcome} />;
  }
}
