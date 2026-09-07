// The control plane refused: its own words, and what they mean for this reader.
//
// BOTH, ALWAYS, AND IN THAT ORDER. The code and the message the wire sent print
// verbatim, and the console's sentence sits beside them — a surface showing only the
// sentence would be answering for a control plane it cannot see, and one showing only
// the code would hand a person a string to search for.
//
// A CODE WITH NO REGISTERED MEANING STILL RENDERS. The wire's message carries it, and
// the console adds nothing rather than guessing — which is what keeps a refusal raised
// by some other subsystem out of the invite plane's own table.

import type { GrowthInviteOutcome } from "../../bridge/index.js";
import { WireFigure } from "../../primitives/index.js";
import { inviteAcceptanceMeaning } from "./invite-refusal-copy.js";

export interface InviteRefusedReadingProps {
  readonly outcome: Extract<GrowthInviteOutcome, { readonly kind: "refused" }>;
}

export function InviteRefusedReading(props: InviteRefusedReadingProps): React.JSX.Element {
  const { outcome } = props;
  const meaning = inviteAcceptanceMeaning(outcome.code);
  return (
    <div className="meridian-invite-outcome__body">
      <h4 className="meridian-invite-outcome__title">This invitation was not accepted.</h4>
      <p className="meridian-invite-outcome__wire">
        <WireFigure value={outcome.code} />
        <span className="meridian-invite-outcome__detail">{outcome.detail}</span>
      </p>
      {meaning === undefined ? null : <p className="meridian-invite-outcome__meaning">{meaning}</p>}
    </div>
  );
}
