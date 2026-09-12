// The session's committed spend, at the end of the all-clear line.
//
// ONE FIGURE, FROM ONE PLACE, WITH NO ARITHMETIC ANYWHERE NEAR IT. This renders the
// accountant's own `committedSpendCents` through the console's one cents formatter
// and nothing else. The one accountant rule — the renderer never sums visible rows —
// is what this module's shape makes checkable: there is no addition in it, and the
// value it is handed comes from a read rather than from the header's own model.
//
// THE UNPRICED READING IS CARRIED, NOT HIDDEN AND NOT ROUNDED AWAY. The accountant
// says whether the figure is fully priced, and a session holding debits it could not
// price is a session whose total is a floor rather than a total. That is the wire's
// own statement about its own number, so it rides the figure as a qualifier — never
// as a second number, and never as a silent absence, which would leave a reader
// treating a floor as a total.

import { useMemo } from "react";

import { WireFigure, formatCentsAsCurrency } from "../../primitives/index.js";
import { Nothing } from "../../primitives/index.js";
import { type SessionHeaderSpendReading } from "./model/session-header-readings.js";
import { type SessionHeaderReadState } from "./model/session-header-read-projection.js";

/** What the accountant calls a figure it could price in full. */
const PRICED_COST_STATUS = "priced";

export interface SessionHeaderSpendProps {
  readonly spend: SessionHeaderReadState<SessionHeaderSpendReading>;
}

export function SessionHeaderSpend(props: SessionHeaderSpendProps): React.JSX.Element {
  const { spend } = props;
  // FORMATTED ONCE PER FIGURE, not once per paint.
  //
  // `formatCentsAsCurrency` reaches `Intl.NumberFormat` through `formatMoney`, which
  // builds a fresh instance per call and additionally reads the currency's minor-unit
  // digits to size its own fraction bounds. The session header sits above the whole console
  // and re-renders on every reading any of its parts subscribes to — presence, run
  // activity, the session's own state — and none of those move the committed spend.
  // Keyed on the cents figure itself, which is the only member the string is a
  // function of: a receipt re-read that returns the same total re-uses it.
  //
  // ABOVE THE UNSETTLED ARM, because a hook cannot sit behind a return, so the memo
  // answers `undefined` for a read that has served no figure — which is also how the
  // served arm is narrowed below, the two being `undefined` in exactly the same case.
  const servedSpend = spend.status === "served" ? spend.value : undefined;
  const committedSpendCents = servedSpend?.committedSpendCents;
  const formattedCommittedSpend = useMemo(
    () =>
      committedSpendCents === undefined ? undefined : formatCentsAsCurrency(committedSpendCents),
    [committedSpendCents],
  );
  if (servedSpend === undefined || formattedCommittedSpend === undefined) {
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
  const isPriced = servedSpend.costStatus === PRICED_COST_STATUS;
  return (
    <span className="meridian-session-header__spend">
      <WireFigure
        value={formattedCommittedSpend}
        title={`${String(servedSpend.committedSpendCents)} cents committed`}
      />
      {isPriced ? null : (
        <span className="meridian-session-header__spend-qualifier" title={servedSpend.costStatus}>
          at least
        </span>
      )}
    </span>
  );
}
