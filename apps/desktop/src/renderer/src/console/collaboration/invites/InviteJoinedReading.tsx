// The session was joined: what the acceptance activated, wire-verbatim.
//
// THREE IDENTIFIERS AND NO NAVIGATION. The membership is real and the frame is not
// this family's to drive — a view family reaches no route — so the reading names what
// exists and leaves opening it to the switcher, which is the one surface that already
// knows how. The role is the wire's own string rather than a friendlier word: it is
// what the membership holds, and a synonym here would be a second vocabulary for a
// value the ledger next door prints verbatim.

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
        The membership is active. Open the session from the switcher whenever you are ready.
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
