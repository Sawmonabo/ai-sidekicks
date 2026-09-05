// One filter axis' chips.
//
// Its own module for the one-component rule, and the split says what the two axes
// share: generic over the value rather than written twice, because they differ in
// exactly one thing — the element type the filter stores — and `EventCategory` is kept
// as its own type all the way to the toggle so a press cannot admit a family the
// contract does not carry.

import { DerivedFigure } from "../../primitives/index.js";
import { type LedgerFacet } from "./filters.js";

export interface LedgerFacetGroupProps<TValue extends string> {
  readonly label: string;
  readonly facets: readonly LedgerFacet<TValue>[];
  readonly isAdmitted: (value: TValue) => boolean;
  readonly onToggle: (value: TValue) => void;
}

/**
 * One axis' chips, or nothing.
 *
 * An axis with nothing on it renders nothing at all: a heading over an empty row
 * would say this window has participants when it has none.
 */
export function LedgerFacetGroup<TValue extends string>(
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
