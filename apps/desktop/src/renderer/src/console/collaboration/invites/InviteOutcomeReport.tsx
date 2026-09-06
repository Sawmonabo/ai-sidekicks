// How an attempt on one invitation ended, in four readings.
//
// FOUR ARMS RATHER THAN TWO, and the split is the whole reason this exists. The
// shipped acceptance path settles resolved-or-rejected, which reads an authentication
// detour and a control-plane refusal as one event — and they are opposites: one is a
// step the person completes and comes back from, the other is a door that is shut. So
// the two authentication arms carry their own reading, they are the only ones that
// offer a second attempt, and a refusal offers none, because pressing again sends the
// identical request to the identical answer.
//
// NOTHING HERE DISPATCHES ANYTHING. Every act is a callback the owner supplies, so
// this is a pure reading of one value and a suite renders all four arms without a
// bridge.

import type { GrowthInviteOutcome } from "../../bridge/index.js";
import { InviteAuthenticationReading } from "./InviteAuthenticationReading.js";
import { InviteJoinedReading } from "./InviteJoinedReading.js";
import { InviteRefusedReading } from "./InviteRefusedReading.js";
import { isRetryableOutcome } from "./pending-invite.js";

export interface InviteOutcomeReportProps {
  readonly outcome: GrowthInviteOutcome;
  /** Try the same reference again. Offered on the two authentication arms only. */
  readonly onRetry: () => void;
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

      <div className="meridian-invite-outcome__acts">
        {/* The retry predicate is the adapter's, consulted rather than re-derived:
            which outcomes a second attempt can help is a property of the lifecycle,
            and a component deciding it separately would be a second answer that goes
            stale the first time an arm is added. */}
        {isRetryableOutcome(outcome) ? (
          <button
            type="button"
            className="meridian-invite-outcome__retry"
            disabled={props.isActing}
            onClick={props.onRetry}
          >
            {props.isActing ? "Trying…" : "Try again"}
          </button>
        ) : null}
        <button
          type="button"
          className="meridian-invite-outcome__acknowledge"
          onClick={props.onAcknowledge}
        >
          Done
        </button>
      </div>
    </section>
  );
}
