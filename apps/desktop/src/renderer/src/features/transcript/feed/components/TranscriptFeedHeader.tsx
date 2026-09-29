// Everything the ledger says above its rows: the find field and the three absences a
// person can still act on.
//
// ITS OWN MODULE BECAUSE IT IS ONE SUBJECT — what this window is NARROWED to, and
// what that narrowing left out — while the feed beside it is about arrangement.
//
// IT DERIVES NOTHING. Every value below is a reading the feed already holds: this
// module decides only which of them reach a screen and in what order. A count
// computed here would be a second answer to a question `ledger-visible-window.ts`
// already answers, and the two would agree until one of them shipped.

import { FindInLedger } from "@renderer/console/ledger/structure/index.js";
import { PartialRead } from "@renderer/console/primitives/index.js";
import { matchWalkReading } from "../../find/find-readings.js";
import { type LedgerFindAndJump } from "../hooks/useTranscriptFindAndJump.js";

/** The find state the header draws its field and counts from. */
export interface LedgerFeedHeaderProps {
  /** The field, the classification of an id, and the acts both offer. */
  readonly findAndJump: LedgerFindAndJump;
}

/** The find field and the counts of matches the window could not reach. */
export function LedgerFeedHeader(props: LedgerFeedHeaderProps): React.JSX.Element {
  const { find } = props.findAndJump;
  return (
    <>
      {find.isOpen ? (
        <FindInLedger
          query={find.query}
          result={find.result}
          currentMatchIndex={find.currentMatchIndex}
          openRequestCount={find.openRequestCount}
          onQueryChange={find.setQuery}
          onStep={props.findAndJump.onStep}
          onClose={props.findAndJump.onClose}
        />
      ) : null}
      {/* Three mounts and three subjects, because the three cuts are three facts with
          three exits: nothing brings a pruned row back, lifting the filter brings
          the narrowed ones, and opening a chapter header brings the folded ones. One
          mount carrying every state would say the same sentence three times over a
          subject nobody could act on. */}
      <PartialRead
        states={[matchWalkReading(find.result.totalMatchCount, find.beyondWindowMatchCount)]}
        subject="this window"
      />
      <PartialRead
        states={[matchWalkReading(find.result.totalMatchCount, find.filteredAwayMatchCount)]}
        subject="the entries this ledger is narrowed to"
      />
      <PartialRead
        states={[matchWalkReading(find.result.totalMatchCount, find.foldedAwayMatchCount)]}
        subject="the run chapters this ledger has folded"
      />
    </>
  );
}
