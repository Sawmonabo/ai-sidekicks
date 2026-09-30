// A provider's mid-run permission request, framed inside the ordinary approval card. This is the
// body the card reserves between its header and action row, not a second card type. It adds two
// things the projection read does not carry: the provenance sentence (`askId` is only on the
// `approval.requested` event) and the requested resource inline, since for a permission ask the
// resource is the whole question.

import "./ProviderAskDetails.css";

import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { ApprovalResource } from "./ApprovalResource.js";
import { type ProviderAsk } from "../provider-ask.js";

/** The provider ask to frame and the resource it requested. */
export interface ProviderAskDetailsProps {
  readonly ask: ProviderAsk;
  /** The audit-grade target, from the parsed record the card is rendering. */
  readonly requestedResource: Readonly<Record<string, unknown>>;
}

/** The provider ask's origin and the resource it requested, inside an ordinary card. */
export function ProviderAskDetails(props: ProviderAskDetailsProps): React.JSX.Element {
  const { ask } = props;
  return (
    <div className="meridian-approval-ask">
      <p className="meridian-approval-ask__origin">
        Raised by the provider during a run, as ask <WireFigure value={ask.askId} />.
      </p>
      <div className="meridian-approval-ask__input">
        <ApprovalResource descriptor={props.requestedResource} />
      </div>
    </div>
  );
}
