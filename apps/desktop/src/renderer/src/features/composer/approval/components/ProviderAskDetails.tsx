// A provider's mid-run PERMISSION request, framed as the ordinary approval it is.
//
// Permission-kind asks belong on the approval card and nowhere else, and they share
// that card ENTIRELY — no additional primitive and no second
// card type. So this is not a card: it is the body `ApprovalCard` already reserves
// between its header and its action row, and the pane hands it there. The two answers
// stay the card's two, because a permission ask is settled as an approval, which is why
// it became one.
//
// WHAT IT ADDS, AND WHY EACH ONE CANNOT BE ON THE CARD. Two things, and both
// come from members the projection READ does not carry:
//
//   • **The provenance sentence.** `askId` is on the `approval.requested` EVENT and
//     on no read, so the card — which renders one parsed projection row — has no way
//     to know a request came from a provider ask at all.
//   • **The requested resource, inline.** The card shows it behind a disclosure,
//     which is right for a request whose category already says what is being asked.
//     For a permission ask the resource is the whole question, so it is shown above
//     the action row rather than behind a click. One implementation renders both —
//     `ApprovalResource.tsx` — so the two placements cannot say different things.
//
// A QUESTION IS NOT HERE. An agent's question is a different record with its own
// card, so exactly one card renders any request and neither has to guess.

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
