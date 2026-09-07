// How an attempt on one invitation ended, in four readings.
//
// FOUR ARMS RATHER THAN TWO, and the split is the whole reason this exists. The
// shipped acceptance path settles resolved-or-rejected, which reads an authentication
// detour and a control-plane refusal as one event — and they are opposites: one is a
// step the person is still taking, the other is a door that is shut. So the two
// authentication arms carry their own reading rather than a refusal's copy.
//
// NO ARM OFFERS A SECOND ATTEMPT, and the two that look as though they should are
// exactly the two that must not. An acceptance waiting on authentication is IN
// PROGRESS: main is driving the ceremony and holding the reference across it, so the
// answer is still coming and a second act would race it. One that FAILED
// authentication is terminal and its reference was released with the failure, so a
// second act would send a spent handle. Trying again means putting a preview to the
// control plane again, which is a property of a pending state and not of an answer
// already given — `pending-invite-reading.ts` is where that lives, and the pending
// arm that admits it carries the attempt handle a retry is dispatched on.
//
// THE IN-PROGRESS ARM CLOSES NOTHING EITHER. Acknowledging clears the prompt, and a
// prompt cleared before its terminal arrives strands that answer against an
// invitation this window no longer holds — so the one act offered there is the
// dismissal the card itself owns, which releases the reference over the wire.
//
// NOTHING HERE DISPATCHES ANYTHING. Every act is a callback the owner supplies, so
// this is a pure reading of one value and a suite renders all four arms without a
// bridge.

import type { GrowthInviteOutcome } from "../../bridge/index.js";
import { InviteAuthenticationReading } from "./InviteAuthenticationReading.js";
import { InviteJoinedReading } from "./InviteJoinedReading.js";
import { InviteRefusedReading } from "./InviteRefusedReading.js";
import { isInviteOutcomeInProgress } from "./pending-invite-reading.js";

export interface InviteOutcomeReportProps {
  readonly outcome: GrowthInviteOutcome;
  /** Put a settled result away and move to whatever was waiting behind it. */
  readonly onAcknowledge: () => void;
  /** True while an act on this reference is unsettled, so a second is not offered. */
  readonly isActing: boolean;
}

export function InviteOutcomeReport(props: InviteOutcomeReportProps): React.JSX.Element {
  const { outcome } = props;
  return (
    <section className="meridian-invite-outcome" aria-label="How this invitation ended">
      {outcome.kind === "joined" ? (
        <InviteJoinedReading outcome={outcome} />
      ) : outcome.kind === "refused" ? (
        <InviteRefusedReading outcome={outcome} />
      ) : (
        <InviteAuthenticationReading outcome={outcome} />
      )}

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
            onClick={props.onAcknowledge}
          >
            Done
          </button>
        </div>
      )}
    </section>
  );
}
