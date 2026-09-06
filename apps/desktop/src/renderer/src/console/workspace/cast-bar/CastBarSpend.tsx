// The session's committed spend, at the end of the all-clear line.
//
// ONE FIGURE, FROM ONE PLACE, WITH NO ARITHMETIC ANYWHERE NEAR IT. This renders the
// accountant's own `committedSpendCents` through the console's one cents formatter
// and nothing else. `Spec-023 §Rules every console surface obeys` puts it plainly
// under One accountant — "the renderer never sums visible rows" — and the shape of
// this module is what makes that checkable: there is no addition in it, and the value
// it is handed comes from a read rather than from the bar's own model.
//
// THE UNPRICED READING IS CARRIED, NOT HIDDEN AND NOT ROUNDED AWAY. The accountant
// says whether the figure is fully priced, and a session holding debits it could not
// price is a session whose total is a floor rather than a total. That is the wire's
// own statement about its own number, so it rides the figure as a qualifier — never
// as a second number, and never as a silent absence, which would leave a reader
// treating a floor as a total.

import { WireFigure, formatCentsAsCurrency } from "../../primitives/index.js";
import { Nothing } from "../../primitives/index.js";
import { type CastBarSpendReading } from "./cast-bar-readings.js";
import { type CastBarReadState } from "./cast-bar-reads.js";

/** What the accountant calls a figure it could price in full. */
const PRICED_COST_STATUS = "priced";

export interface CastBarSpendProps {
  readonly spend: CastBarReadState<CastBarSpendReading>;
}

export function CastBarSpend(props: CastBarSpendProps): React.JSX.Element {
  const { spend } = props;
  if (spend.status !== "served") {
    // Both unsettled arms render the same absence, and that is exact rather than
    // lazy: "the console has not read a figure" is true while the read is in flight
    // and true when it was refused, and the difference between them is a fact about
    // the console rather than about the session's spend. The refusal's own words ride
    // the badge's tooltip where there is one, so the two are still distinguishable to
    // anyone asking why.
    return (
      <Nothing
        kind="not-checked"
        title="Session spend"
        detail={
          spend.status === "unavailable"
            ? `${spend.refusal.code}: ${spend.refusal.detail}`
            : "No cost receipt has been read."
        }
      />
    );
  }
  const isPriced = spend.value.costStatus === PRICED_COST_STATUS;
  return (
    <span className="meridian-cast-bar__spend">
      <WireFigure
        value={formatCentsAsCurrency(spend.value.committedSpendCents)}
        title={`${String(spend.value.committedSpendCents)} cents committed`}
      />
      {isPriced ? null : (
        <span className="meridian-cast-bar__spend-qualifier" title={spend.value.costStatus}>
          at least
        </span>
      )}
    </span>
  );
}
