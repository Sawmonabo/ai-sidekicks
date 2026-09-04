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
// shows and reads as MB where the rest of the product reads MiB; a second scaling
// written here would be the second byte formatter `apps/desktop/AGENTS.md` names a
// chokepoint breach. So the surface dispatches and never converts, and the exact
// wire value rides the figure as its title so a reviewer can still read the byte.
//
// The meter renders nothing on its own initiative — 12.10's "Renders. Nothing
// normally." — and the pane mounts it behind a disclosure, which is rule 7's "one
// click away". A bound with no live reading renders the not-checked absence rather
// than a zero, because "nothing is using this" and "nobody measured" are different
// facts and only one of them is true today.

import {
  BROWSER_BOUNDS,
  BROWSER_BOUND_NAMES,
  BROWSER_SCALAR_UNIT_BYTE_QUALIFIER,
  type BrowserBoundMeasure,
  type BrowserBoundName,
  type BrowserScalarUnit,
} from "../core/index.js";
import { Glyph, Nothing, formatByteQuantity, formatCount } from "../primitives/index.js";

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
      <td title={scalarFigureTitle(bound.measure)}>{describeMeasure(bound.measure)}</td>
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
  return describeScalarCeiling(measure.value, measure.unit);
}

/**
 * One figure in the chokepoint its unit declares — the ONE dispatch, shared by the
 * ceiling column and the reading column beside it.
 *
 * Shared rather than written twice because the two columns are read against each
 * other: a column that scaled the ceiling and not the reading would put a `KiB`
 * beside a decimal byte count and invite exactly the comparison that is wrong.
 *
 * The dispatch is a lookup rather than a test here. This surface owns the layout;
 * which chokepoint a unit goes through is `core/constants.ts`'s declaration.
 */
function scaleScalarFigure(value: number, unit: BrowserScalarUnit): string {
  return BROWSER_SCALAR_UNIT_BYTE_QUALIFIER[unit] === undefined
    ? formatCount(value)
    : formatByteQuantity(value).text;
}

/**
 * A ceiling: the figure, and the unit words that survive the scaling.
 *
 * A counted ceiling carries its whole unit as a word. A byte one carries whatever the
 * unit still says once `formatByteQuantity` has supplied `KiB` in place of `bytes` —
 * nothing for a bare byte ceiling, `per entry` for a per-entry one. The reading
 * column deliberately carries no unit word at all: the row already names it once, and
 * a byte quantity brings its own binary label with it.
 */
function describeScalarCeiling(value: number, unit: BrowserScalarUnit): string {
  const byteQualifier = BROWSER_SCALAR_UNIT_BYTE_QUALIFIER[unit];
  if (byteQualifier === undefined) {
    return `${formatCount(value)} ${unit}`;
  }
  const quantity = scaleScalarFigure(value, unit);
  return byteQualifier === "" ? quantity : `${quantity} ${byteQualifier}`;
}

/**
 * The exact figure, for the cell that scaled it — and nothing for one that did not.
 *
 * A scaled byte quantity is rounded to one fraction digit, so the byte a refusal
 * would name is no longer on screen; the title is where it stays readable. A counted
 * figure is already exact, and a title repeating it would be noise on nineteen rows.
 */
function exactFigureTitle(value: number, unit: BrowserScalarUnit): string | undefined {
  return BROWSER_SCALAR_UNIT_BYTE_QUALIFIER[unit] === undefined ? undefined : String(value);
}

/** The same, for a ceiling — absent on the two kinds that carry no single number. */
function scalarFigureTitle(measure: BrowserBoundMeasure): string | undefined {
  return measure.kind === "scalar" ? exactFigureTitle(measure.value, measure.unit) : undefined;
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
    <span className={className} title={exactFigureTitle(props.reading, props.measure.unit)}>
      {isTripped ? <Glyph name="alert" size={ALERT_GLYPH_SIZE} /> : null}
      {scaleScalarFigure(props.reading, props.measure.unit)}
      {isTripped ? <span>at the ceiling</span> : null}
    </span>
  );
}
