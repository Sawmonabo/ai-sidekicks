// A provider's mid-run PERMISSION request, framed as the ordinary approval it is.
//
// `Spec-023 §Console Design (Meridian)` puts permission-kind asks on the approvals
// surface and nowhere else, and has that surface share the approval card ENTIRELY —
// no additional primitive and no second card type. So this is not a card: it is the
// body `ApprovalCard` already reserves between its header and its action row, and
// the pane hands it there. The two answers stay the card's two, because a permission
// ask is settled as an approval, which is why it became one.
//
// WHAT IT ADDS, AND WHY EACH ONE CANNOT BE ON THE CARD. Three things, and all three
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
//   • **The deadline, read against the shared clock.** NO SECOND CLOCK: the instant
//     shown is the request's own `expiryAt`, which equals the ask's `expiresAt` —
//     one passage, two registered surfaces — and the reading beside it is a
//     derivation of that instant against the clock the console already reads once
//     per render. This component arms no timer, counts nothing down, and settles no
//     terminal: when the deadline passes, the daemon owns the transition and this
//     surface waits for it.
//
// THE INPUT-KIND ASK IS NOT HERE. The `kind` discriminator on the originating ask
// selects between this surface and the input-ask card, so exactly one of the two
// renders any given ask and neither has to guess. The input card is the ledger
// family's, and the `driver.respondToRequest` ingress that answers one is reached
// from nowhere on this surface.

import { DerivedFigure, WireFigure, formatRelativeTime } from "../../../primitives/index.js";
import { ApprovalResource } from "./ApprovalResource.js";
import { type ProviderAsk } from "./provider-ask.js";

export interface ProviderAskFramingProps {
  readonly ask: ProviderAsk;
  /** The audit-grade target, from the parsed record the card is rendering. */
  readonly requestedResource: Readonly<Record<string, unknown>>;
  /** The console's one clock reading for this render. Never a second clock. */
  readonly nowMilliseconds: number;
}

export function ProviderAskFraming(props: ProviderAskFramingProps): React.JSX.Element {
  const { ask } = props;
  return (
    <div className="meridian-approval-ask">
      <p className="meridian-approval-ask__origin">
        Raised by the provider during a run, as ask <WireFigure value={ask.askId} />.
      </p>
      <div className="meridian-approval-ask__input">
        <ApprovalResource descriptor={props.requestedResource} />
      </div>
      {ask.expiryAt === undefined ? (
        // The wire requires a deadline beside `askId`, so this is a reply that broke
        // its own pairing. Said plainly and counted by the pane — never filled in
        // with a deadline no daemon sent.
        <p className="meridian-approval-ask__missing">
          This ask reached the console without the deadline the wire carries beside it, so no expiry
          is shown here.
        </p>
      ) : (
        <p className="meridian-approval-ask__deadline">
          Answer needed{" "}
          <DerivedFigure text={formatRelativeTime(ask.expiryAt, props.nowMilliseconds)} />
          , at <WireFigure value={ask.expiryAt} />.
        </p>
      )}
      <p className="meridian-approval-ask__expiry-outcome">
        If this deadline passes unanswered the daemon denies it through the provider&apos;s own deny
        path and the run continues. It is never approved by silence, and the session is not ended.
      </p>
    </div>
  );
}
