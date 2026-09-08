// The control plane refused the ACCEPTANCE: the heading for it, and the wire's words.
//
// What this arm owns is the sentence naming what failed — an attempt on a reference
// that existed. The code, the message and the meaning beside them are
// `InviteRefusalWords.tsx`, shared with the refused PREVIEW, because the two refusals
// are different facts read the same way and that module states the rule for both.

import type { GrowthInviteOutcome } from "../../bridge/index.js";
import { InviteRefusalWords } from "./InviteRefusalWords.js";

export interface InviteRefusedReadingProps {
  readonly outcome: Extract<GrowthInviteOutcome, { readonly kind: "refused" }>;
}

export function InviteRefusedReading(props: InviteRefusedReadingProps): React.JSX.Element {
  const { outcome } = props;
  return (
    <div className="meridian-invite-outcome__body">
      <h4 className="meridian-invite-outcome__title">This invitation was not accepted.</h4>
      <InviteRefusalWords code={outcome.code} detail={outcome.detail} />
    </div>
  );
}
