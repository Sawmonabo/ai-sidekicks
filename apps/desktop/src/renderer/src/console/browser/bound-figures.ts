// How one bound's figures are spelled — the ceiling, the reading, and the exact
// number a scaled cell no longer shows.
//
// A model beside its two components rather than inside either, because BOTH read it:
// the ceiling column and the reading column are read against each other, and a column
// that scaled one and not the other would put a binary figure beside a decimal byte
// count and invite exactly the comparison that is wrong. One dispatch, so they cannot
// come to disagree.
//
// Pure and React-free, so the rounding rules below are driven without rendering a
// table around them.

import {
  BROWSER_SCALAR_UNIT_BYTE_QUALIFIER,
  type BrowserBoundMeasure,
  type BrowserScalarUnit,
} from "../core/index.js";
import { formatByteQuantity, formatCount } from "../primitives/index.js";

export function describeMeasure(measure: BrowserBoundMeasure): string {
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
 * other: a column that scaled the ceiling and not the reading would put a binary
 * figure beside a decimal byte count and invite exactly the comparison that is wrong.
 *
 * The dispatch is a lookup rather than a test here. This surface owns the layout;
 * which chokepoint a unit goes through is `core/constants.ts`'s declaration.
 */
export function scaleScalarFigure(value: number, unit: BrowserScalarUnit): string {
  return BROWSER_SCALAR_UNIT_BYTE_QUALIFIER[unit] === undefined
    ? formatCount(value)
    : formatByteQuantity(value).text;
}

/**
 * A ceiling: the figure, and the unit words that survive the scaling.
 *
 * A counted ceiling carries its whole unit as a word. A byte one carries whatever the
 * unit still says once `formatByteQuantity` has supplied a binary unit label in place
 * of `bytes` — nothing for a bare byte ceiling, `per entry` for a per-entry one. The
 * reading
 * column deliberately carries no unit word at all: the row already names it once, and
 * a byte quantity brings its own binary label with it.
 */
export function describeScalarCeiling(value: number, unit: BrowserScalarUnit): string {
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
export function exactFigureTitle(value: number, unit: BrowserScalarUnit): string | undefined {
  return BROWSER_SCALAR_UNIT_BYTE_QUALIFIER[unit] === undefined ? undefined : String(value);
}

/** The same, for a ceiling — absent on the two kinds that carry no single number. */
export function scalarFigureTitle(measure: BrowserBoundMeasure): string | undefined {
  return measure.kind === "scalar" ? exactFigureTitle(measure.value, measure.unit) : undefined;
}
