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

import { DerivedFigure } from "../../primitives/index.js";
import {
  UNFILTERED_LEDGER,
  isLedgerFiltered,
  withToggledCategory,
  withToggledParticipant,
  type LedgerFacet,
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

interface LedgerFacetGroupProps<TValue extends string> {
  readonly label: string;
  readonly facets: readonly LedgerFacet<TValue>[];
  readonly isAdmitted: (value: TValue) => boolean;
  readonly onToggle: (value: TValue) => void;
}

/**
 * One axis' chips.
 *
 * Generic over the value rather than written twice, because the two axes differ in
 * exactly one thing — the element type the filter stores — and `EventCategory` is
 * kept as its own type all the way to the toggle so a press cannot admit a family
 * the contract does not carry.
 *
 * An axis with nothing on it renders nothing at all: a heading over an empty row
 * would say this window has participants when it has none.
 */
function LedgerFacetGroup<TValue extends string>(
  props: LedgerFacetGroupProps<TValue>,
): React.JSX.Element | null {
  if (props.facets.length === 0) {
    return null;
  }
  return (
    <div className="meridian-ledger-filter__axis" role="group" aria-label={props.label}>
      <span className="meridian-ledger-filter__axis-label">{props.label}</span>
      {props.facets.map((facet) => (
        <button
          key={facet.value}
          type="button"
          className="meridian-ledger-filter__facet"
          // `aria-pressed` rather than a selected class alone: the chip is a toggle,
          // and the state a screen reader announces is the state the filter is in.
          aria-pressed={props.isAdmitted(facet.value)}
          onClick={() => {
            props.onToggle(facet.value);
          }}
        >
          <span className="meridian-ledger-filter__facet-value">{facet.value}</span>
          <DerivedFigure text={String(facet.rowCount)} />
        </button>
      ))}
    </div>
  );
}
