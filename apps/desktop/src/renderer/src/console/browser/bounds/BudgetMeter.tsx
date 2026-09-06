// The browser pane's resource ceiling, rendered.
//
// `Spec-023 §Console Design (Meridian)` 12.10 asks for "one place to audit" the
// ceiling and for "every bound a named constant in one module". The MODULE is
// `console/core/constants.ts`, which `apps/desktop/AGENTS.md` §Config
// single-sourcing makes the console's one home for a cap; this file is the surface
// that renders what is declared there.
//
// The block used to live here, beside the table that displays it, on the reading
// that a constants file nobody displays is audited by whoever opens the file. That
// put the browser's twenty runtime ceilings in a component while the terminal's
// three sat in a third module, so the console's cap inventory was in three places
// and an audit had to know all of them. The rendering is what belongs here; the
// numbers and their derivations belong where every other cap is.
//
// Nothing below decides how a figure is formatted, and nothing below scales one. The
// unit a bound DECLARES says which of the console's two figure chokepoints it goes
// through — `formatCount` for a counted ceiling, `formatByteQuantity` for a
// byte-valued one — and `core/constants.ts` carries that answer as a map total over
// its own unit set. A byte ceiling sent through `formatCount` renders raw decimal
// bytes, which is a figure that disagrees with every other byte quantity the console
// shows, and reads in powers of a thousand where the rest of the product reads in
// powers of 1024; a second scaling
// written here would be the second byte formatter `apps/desktop/AGENTS.md` names a
// chokepoint breach. So the surface dispatches and never converts, and the exact
// wire value rides the figure as its title so a reviewer can still read the byte.
//
// The meter renders nothing on its own initiative — 12.10's "Renders. Nothing
// normally." — and the pane mounts it behind a disclosure, which is rule 7's "one
// click away". A bound with no live reading renders the not-checked absence rather
// than a zero, because "nothing is using this" and "nobody measured" are different
// facts and only one of them is true today.

import { BROWSER_BOUND_NAMES, type BrowserBoundName } from "./browser-bounds.js";
import { BoundRow } from "./BoundRow.js";

/** A live reading for a scalar bound. Absent means nobody measured, not zero. */
export type BrowserBoundReadings = Readonly<Partial<Record<BrowserBoundName, number>>>;

export interface BudgetMeterProps {
  /** What this pane can actually count right now. Usually one or two entries. */
  readonly readings?: BrowserBoundReadings;
}

/**
 * The ceiling, as a table.
 *
 * A `<table>` rather than a list of cards because this is a ledger of twenty rows a
 * reviewer scans down one column of, which is the shape a table is for and the shape
 * rule 5's density argument asks for wherever the data is dense.
 */
export function BudgetMeter(props: BudgetMeterProps): React.JSX.Element {
  const readings = props.readings ?? {};
  return (
    <table className="meridian-browser-bounds">
      <caption className="meridian-browser-bounds__caption">
        Every ceiling the embedded browser spends, and where each number comes from.
      </caption>
      <thead>
        <tr>
          <th scope="col">Bound</th>
          <th scope="col">Ceiling</th>
          <th scope="col">Now</th>
          <th scope="col">Why this number</th>
        </tr>
      </thead>
      <tbody>
        {BROWSER_BOUND_NAMES.map((name) => (
          <BoundRow key={name} name={name} reading={readings[name]} />
        ))}
      </tbody>
    </table>
  );
}
