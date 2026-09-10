// Everything the ledger says above its rows: the find field, the facet bar, the id
// jump, and the three absences a person can still act on.
//
// ITS OWN MODULE BECAUSE IT IS ONE SUBJECT — what this window is NARROWED to, and
// what that narrowing left out — while the feed beside it is about arrangement. Read
// inside the composition it came from, this row of elements was sixty lines of JSX
// above a viewport, and the four suites that ask about them
// (`LedgerFeed.filters.test.tsx`, `LedgerFeed.jump.test.tsx`,
// `LedgerFeed.absences.test.tsx`, `LedgerFeed.renders.test.tsx`) had to mount the
// whole ledger to reach a facet chip.
//
// IT DERIVES NOTHING. Every value below is a reading the feed already holds: this
// module decides only which of them reach a screen and in what order. A count
// computed here would be a second answer to a question `ledger-visible-window.ts`
// already answers, and the two would agree until one of them shipped.

import {
  FindInLedger,
  LedgerFilterBar,
  type LedgerFacets,
  type LedgerFilter,
} from "../../../structure/index.js";
import { PartialRead } from "../../../../primitives/index.js";
import { LedgerEventIdJump, matchWalkReading } from "../../find/index.js";
import { type LedgerFindAndJump } from "../model/index.js";

export interface LedgerFeedHeaderProps {
  /** The field, the classification of an id, and the acts both offer. */
  readonly findAndJump: LedgerFindAndJump;
  readonly facets: LedgerFacets;
  readonly filter: LedgerFilter;
  readonly onFilterChange: (filter: LedgerFilter) => void;
  /** The ledger's one scroll writer, handed down so no element here holds a second. */
  readonly onJumpToRow: (rowId: string) => void;
}

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
      <LedgerFilterBar
        facets={props.facets}
        filter={props.filter}
        onFilterChange={props.onFilterChange}
      />
      <LedgerEventIdJump
        outcome={props.findAndJump.outcome}
        reach={props.findAndJump.reach}
        onJumpToRow={props.onJumpToRow}
      />
      {/* Three mounts and three subjects, because the three cuts are three facts with
          three exits: nothing brings a pruned row back, clearing the facet bar brings
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
