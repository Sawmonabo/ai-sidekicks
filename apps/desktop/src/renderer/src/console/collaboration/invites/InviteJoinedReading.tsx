// The session was joined: what the acceptance activated, wire-verbatim.
//
// THREE IDENTIFIERS, AND THE NAVIGATION IS NOT THIS COMPONENT'S. `Plan-023`
// T-023r-6-3 puts the navigation on the `joined` outcome EVENT rather than on any
// press — the reply to `invite.confirmPending` resolves to `void`, so the event is the
// first thing that says a membership exists — and the lifecycle hosting this card
// performs it through the act the frame handed down (`joined-outcome-navigation.ts`).
// So this reading names what was activated and offers no control of its own: a view
// family reaches no route, and a second way into the session would be a second answer
// to a question the outcome already settled.
//
// The role is the wire's own string rather than a friendlier word: it is what the
// membership holds, and a synonym here would be a second vocabulary for a value the
// ledger next door prints verbatim.

import type { GrowthInviteOutcome } from "../../bridge/index.js";
import { Chip, WireFigure } from "../../primitives/index.js";

export interface InviteJoinedReadingProps {
  readonly outcome: Extract<GrowthInviteOutcome, { readonly kind: "joined" }>;
}

export function InviteJoinedReading(props: InviteJoinedReadingProps): React.JSX.Element {
  const { outcome } = props;
  return (
    <div className="meridian-invite-outcome__body meridian-invite-outcome__body--joined">
      <h4 className="meridian-invite-outcome__title">You are in.</h4>
      <p className="meridian-invite-outcome__lede">
        The membership is active, and this window has opened the session behind this card.
      </p>
      <dl className="meridian-invite-outcome__facts">
        <div className="meridian-invite-outcome__fact">
          <dt>Session</dt>
          <dd>
            <WireFigure value={outcome.sessionId} />
          </dd>
        </div>
        <div className="meridian-invite-outcome__fact">
          <dt>Membership</dt>
          <dd>
            <WireFigure value={outcome.membershipId} />
          </dd>
        </div>
        <div className="meridian-invite-outcome__fact">
          <dt>As</dt>
          <dd>
            <Chip label={outcome.role} mono tone="accent" />
          </dd>
        </div>
      </dl>
    </div>
  );
}
