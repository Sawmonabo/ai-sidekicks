// A provider's mid-run PERMISSION request, rendered as the ordinary approval it is.
//
// `Spec-023 §Console Design (Meridian)` §7.8: permission-kind asks render here and
// nowhere else, and the surface "shares 7.6's card entirely; no additional
// primitive, and no second card type". So this file composes `ApprovalCard` and
// adds exactly two things it cannot know on its own — the normalized requested
// resource, shown inline because it is the whole question, and the sentence about
// what happens if nobody answers.
//
// THE INPUT-KIND ASK IS NOT HERE. The `kind` discriminator on the event selects
// between this surface and the input-ask card, so exactly one of the two renders
// any given ask and neither has to guess. The input card is the ledger family's,
// and the `driver.respondToRequest` ingress that answers one is reached from
// nowhere on this surface.
//
// NO SECOND CLOCK. The deadline shown is the pipeline request's `expiryAt`, which
// equals the ask's `expiresAt` — one passage, two registered surfaces. This
// component runs no timer and settles no terminal: when the countdown reaches zero
// the daemon owns the transition and this surface waits for it.

import { WireFigure } from "../../primitives/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { type ApprovalRecord } from "./approval-records.js";
import { type ApprovalResolveRequest } from "./approvals-wire.js";

export interface DriverAskCardProps {
  readonly record: ApprovalRecord;
  readonly isResolving: boolean;
  readonly refusal: ConsoleRefusal | undefined;
  readonly onResolve: (request: ApprovalResolveRequest) => void;
}

export function DriverAskCard(props: DriverAskCardProps): React.JSX.Element {
  const { record } = props;
  return (
    <div className="meridian-approval-ask">
      <ApprovalCard
        record={record}
        isResolving={props.isResolving}
        refusal={props.refusal}
        onResolve={props.onResolve}
      >
        <div className="meridian-approval-ask__body">
          <p className="meridian-approval-ask__origin">
            Raised by the provider during a run, as ask <WireFigure value={record.askId ?? ""} />.
          </p>
          {record.resourceDescriptor === undefined ? (
            // The ask's `input` is required for `kind: 'permission'`, so its absence
            // is a reply this build cannot show the question for — said plainly
            // rather than rendered as a decision about nothing.
            <p className="meridian-approval-ask__missing">
              The reply carried no requested resource, so what will actually run is not shown here.
            </p>
          ) : (
            <p className="meridian-approval-ask__input">
              <WireFigure value={record.resourceDescriptor} />
            </p>
          )}
          <p className="meridian-approval-ask__expiry-outcome">
            If this deadline passes unanswered the daemon denies it through the provider&apos;s own
            deny path and the run continues. It is never approved by silence, and the session is not
            ended.
          </p>
        </div>
      </ApprovalCard>
    </div>
  );
}
