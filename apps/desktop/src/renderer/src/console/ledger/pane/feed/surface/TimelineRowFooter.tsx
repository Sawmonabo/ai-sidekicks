// The footer under a participant message row, and the two nothings it renders as.
//
// ITS OWN MODULE FOR THE ONE-COMPONENT RULE, and because the two conditions it
// answers are decisions rather than markup: whether this row takes a footer at all
// (a wire-verbatim reading of the row's `type`, owned by the seat next door) and
// whether anybody has filled the seat.
//
// AN EMPTY SEAT RENDERS NOTHING AT ALL, WHICH IS THE ONE PLACE THIS FAMILY DIFFERS
// FROM ITS OTHER SLOTS. A pane-sized slot renders the "reserved, not stubbed"
// sentence because a person looking at an empty pane needs to be told the pane is
// reserved. A row footer repeats once per participant message — a reserved marker
// there would print a paragraph of unbuilt-feature prose down the whole ledger, and
// the honest reading of an absent offer is the absent offer — the same reading that
// took the structural surfaces' load-earlier buttons out, recorded in
// `pane/feed/LedgerFeed.tsx`. The three facts the seat answers live in
// `seats/single-slot/timeline-row-footer-seat.ts` for the developer who needs them.

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { rowTakesFooter, type TimelineRowFooterRenderer } from "../../../../seats/index.js";

export interface TimelineRowFooterProps {
  readonly row: TimelineRow;
  readonly isSuperseded: boolean;
  /** The seat's renderer, resolved by the caller. `undefined` while unfilled. */
  readonly renderFooter: TimelineRowFooterRenderer | undefined;
}

/** Draw one row's footer through the seat, or draw nothing. */
export function TimelineRowFooter(props: TimelineRowFooterProps): React.ReactNode {
  const renderFooter = props.renderFooter;
  if (renderFooter === undefined || !rowTakesFooter(props.row)) {
    return null;
  }
  return (
    <div className="meridian-ledger-row__footer">
      {renderFooter({ row: props.row, isSuperseded: props.isSuperseded })}
    </div>
  );
}
