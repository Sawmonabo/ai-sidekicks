// The facet bar — the only surface that can narrow this ledger.
//
// `Spec-023 §Console Design (Meridian)` names filtering by participant and by event
// family as a timeline interaction over the loaded window. `filters.ts` has held the
// whole narrowing model since it was written; this is the control that reaches it,
// and until it existed the model was unreachable from anywhere in the application.
//
// WHAT IT OFFERS IS DERIVED, NEVER LISTED. Both axes come from
// `deriveLedgerFacets` over the window's own rows, so the families offered are the
// families present: the contract exports the `EventCategory` union but no array of
// it, and a list re-typed here would be a second closed set that drifts from the
// first. A menu of twenty families, eighteen of which match nothing in this session,
// is a menu nobody reads.
//
// THE COUNTS ARE THE POINT, not decoration. A facet with a count is a choice a
// person can make; a bare list of names makes them guess which one narrows to
// anything. They are this console's own reading over rows it holds, so they render
// through `DerivedFigure` rather than in the mono the daemon's own figures wear.
//
// THE BAR HOLDS NO FILTER. Every press publishes the next filter value through
// `onFilterChange`, and the current one arrives as a prop — the feed is the one
// owner, because the feed is what applies it.

import { LedgerFacetGroup } from "./LedgerFacetGroup.js";
import {
  UNFILTERED_LEDGER,
  isLedgerFiltered,
  withToggledCategory,
  withToggledParticipant,
  type LedgerFacets,
  type LedgerFilter,
} from "./filters.js";

export interface LedgerFilterBarProps {
  /** Every value this window offers to narrow on, in first-appearance order. */
  readonly facets: LedgerFacets;
  /** What the ledger is narrowed to now. */
  readonly filter: LedgerFilter;
  readonly onFilterChange: (filter: LedgerFilter) => void;
}

export function LedgerFilterBar(props: LedgerFilterBarProps): React.JSX.Element | null {
  const { facets, filter, onFilterChange } = props;
  if (facets.participants.length === 0 && facets.categories.length === 0) {
    // Nothing to narrow on is not an empty bar: a control offering no choices is
    // chrome that teaches a person the ledger cannot be filtered.
    return null;
  }
  return (
    <div className="meridian-ledger-filter" role="group" aria-label="Narrow the ledger">
      <LedgerFacetGroup
        label="Participant"
        facets={facets.participants}
        isAdmitted={(value) => filter.participantIds.includes(value)}
        onToggle={(value) => {
          onFilterChange(withToggledParticipant(filter, value));
        }}
      />
      <LedgerFacetGroup
        label="Event family"
        facets={facets.categories}
        isAdmitted={(value) => filter.categories.includes(value)}
        onToggle={(value) => {
          onFilterChange(withToggledCategory(filter, value));
        }}
      />
      {isLedgerFiltered(filter) ? (
        <button
          type="button"
          className="meridian-ledger-filter__clear"
          onClick={() => {
            onFilterChange(UNFILTERED_LEDGER);
          }}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
