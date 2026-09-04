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
// Nothing below scales anything. Every figure goes through `formatCount`, the
// console's one quantity formatter, and carries its unit as a word — scaling a byte
// ceiling to a binary unit here would be the second byte formatter
// `apps/desktop/AGENTS.md` names a chokepoint breach.
//
// The meter renders nothing on its own initiative — 12.10's "Renders. Nothing
// normally." — and the pane mounts it behind a disclosure, which is rule 7's "one
// click away". A bound with no live reading renders the not-checked absence rather
// than a zero, because "nothing is using this" and "nobody measured" are different
// facts and only one of them is true today.

import {
  BROWSER_BOUNDS,
  BROWSER_BOUND_NAMES,
  type BrowserBoundMeasure,
  type BrowserBoundName,
} from "../core/index.js";
import { Glyph, Nothing, formatCount } from "../primitives/index.js";

/** A live reading for a scalar bound. Absent means nobody measured, not zero. */
export type BrowserBoundReadings = Readonly<Partial<Record<BrowserBoundName, number>>>;

export interface BudgetMeterProps {
  /** What this pane can actually count right now. Usually one or two entries. */
  readonly readings?: BrowserBoundReadings;
}

const ALERT_GLYPH_SIZE = 12;

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

function BoundRow(props: {
  readonly name: BrowserBoundName;
  readonly reading: number | undefined;
}): React.JSX.Element {
  const bound = BROWSER_BOUNDS[props.name];
  return (
    <tr>
      <th scope="row" className="meridian-browser-bounds__name">
        {props.name}
      </th>
      <td>{describeMeasure(bound.measure)}</td>
      <td>
        <BoundReading measure={bound.measure} reading={props.reading} />
      </td>
      <td className="meridian-browser-bounds__why">{bound.derivation}</td>
    </tr>
  );
}

function describeMeasure(measure: BrowserBoundMeasure): string {
  if (measure.kind === "deferred") {
    return `owned by ${measure.owner}`;
  }
  if (measure.kind === "extent") {
    return `${formatCount(measure.widthPx)} by ${formatCount(measure.heightPx)} px`;
  }
  return `${formatCount(measure.value)} ${measure.unit}`;
}

function BoundReading(props: {
  readonly measure: BrowserBoundMeasure;
  readonly reading: number | undefined;
}): React.JSX.Element {
  if (props.reading === undefined || props.measure.kind !== "scalar") {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title="Not measured"
        detail="Nothing in this window meters this ceiling yet, so the console does not report a figure for it. That is not the same as reporting zero."
      />
    );
  }
  const isTripped = props.reading >= props.measure.value;
  const className = isTripped
    ? "meridian-browser-bounds__reading meridian-browser-bounds__reading--tripped"
    : "meridian-browser-bounds__reading";
  return (
    <span className={className}>
      {isTripped ? <Glyph name="alert" size={ALERT_GLYPH_SIZE} /> : null}
      {formatCount(props.reading)}
      {isTripped ? <span>at the ceiling</span> : null}
    </span>
  );
}
