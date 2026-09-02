// The browser pane's resource ceiling, named once and shown in one place.
//
// `Spec-023 §Console Design (Meridian)` 12.10: "Make the resource ceiling a named,
// auditable block rather than a set of numbers discovered under load … Every bound is
// a named constant in one module, and every refusal names the constant it hit." This
// module is that block and the surface that renders it, which is deliberate: a
// constants file nobody displays is audited by whoever opens the file, and 12.10 asks
// for "one place to audit".
//
// Three things the table below is careful about:
//
//   • **A bound the console does not own has no number here.** Capture and download
//     bytes are the attachment ingest pipeline's, from
//     `Spec-014 §Bounds (normative defaults; operator-tunable)`; minting a second
//     ceiling would let the two drift, and a row saying so is more useful than a row
//     that is quietly missing.
//   • **A bound that must equal something else IMPORTS it.** `SNAPSHOT_TEXT_MAX` is
//     the event log's content ceiling, so it is that constant rather than a copy of
//     its digits — which is what makes "a snapshot result seals into the content
//     column without truncation" a fact rather than a hope.
//   • **Nothing is scaled.** Every figure goes through `formatCount`, the console's
//     one quantity formatter, and carries its unit as a word. Scaling a byte ceiling
//     to a binary unit here would be the second byte formatter
//     `apps/desktop/AGENTS.md` names a chokepoint breach.
//
// The meter renders nothing on its own initiative — 12.10's "Renders. Nothing
// normally." — and the pane mounts it behind a disclosure, which is rule 7's "one
// click away". A bound with no live reading renders the not-checked absence rather
// than a zero, because "nothing is using this" and "nobody measured" are different
// facts and only one of them is true today.

import { CONTENT_PAYLOAD_PLAINTEXT_MAX } from "@ai-sidekicks/contracts";
import { Glyph, Nothing, formatCount } from "../primitives/index.js";

/**
 * Every bound, by the constant name 12.10 gives it. Closed, and the tuple is the
 * declaration: a refusal has to be able to name the constant it hit, and a name that
 * is not in this set is a number discovered under load.
 */
export const BROWSER_BOUND_NAMES = [
  "PAGES_PER_RUN_MAX",
  "PAGES_PER_SESSION_MAX",
  "PAGES_PER_NODE_MAX",
  "VIEWS_MAX",
  "SESSION_PARTITIONS_MAX",
  "SNAPSHOT_TEXT_MAX",
  "SNAPSHOT_ELEMENTS_MAX",
  "EVALUATE_RESULT_MAX",
  "LOCATOR_RESULT_MAX",
  "CONSOLE_RING_ENTRIES",
  "CONSOLE_ENTRY_MAX",
  "CLIPBOARD_MAX",
  "FULL_PAGE_CAPTURE_MAX",
  "CAPTURE_AND_DOWNLOAD_BYTES",
  "VIEWPORT_DEFAULT",
  "VIEWPORT_MIN",
  "VIEWPORT_MAX",
  "PAGE_OPERATION_TIMEOUT_MS",
  "VIEW_IDLE_TEARDOWN_MS",
  "VIEW_RESIDENT_BUDGET_MB",
] as const;

export type BrowserBoundName = (typeof BROWSER_BOUND_NAMES)[number];

/**
 * How a bound is measured. Three kinds, because three genuinely different things are
 * being said: one number, a pixel box, or "this ceiling belongs to somebody else".
 */
export type BrowserBoundMeasure =
  | { readonly kind: "scalar"; readonly value: number; readonly unit: string }
  | { readonly kind: "extent"; readonly widthPx: number; readonly heightPx: number }
  | { readonly kind: "deferred"; readonly owner: string };

export interface BrowserBound {
  readonly measure: BrowserBoundMeasure;
  /** Why this number and not another. 12.10's derivation column, in its own words. */
  readonly derivation: string;
}

function scalar(value: number, unit: string, derivation: string): BrowserBound {
  return { measure: { kind: "scalar", value, unit }, derivation };
}

function extent(widthPx: number, heightPx: number, derivation: string): BrowserBound {
  return { measure: { kind: "extent", widthPx, heightPx }, derivation };
}

/**
 * The block. Total over `BrowserBoundName` by construction, so a bound added to the
 * tuple above fails to compile until it has a number and a derivation.
 */
export const BROWSER_BOUNDS: Readonly<Record<BrowserBoundName, BrowserBound>> = {
  PAGES_PER_RUN_MAX: scalar(
    8,
    "pages",
    "Eight labelled tabs are what the strip renders legibly at the pane's minimum width; past that the strip stops being an index of what the agent opened.",
  ),
  PAGES_PER_SESSION_MAX: scalar(
    24,
    "pages",
    "Three concurrently attached agents at the per-run ceiling.",
  ),
  PAGES_PER_NODE_MAX: scalar(
    64,
    "pages",
    "The node ceiling, sized so no single session can starve another.",
  ),
  VIEWS_MAX: scalar(8, "views", "One live view per open browser pane; the deck holds no more."),
  SESSION_PARTITIONS_MAX: scalar(
    12,
    "partitions",
    "Resident partitions; the least recently used is evicted, and eviction closes its pages first.",
  ),
  SNAPSHOT_TEXT_MAX: scalar(
    CONTENT_PAYLOAD_PLAINTEXT_MAX,
    "bytes",
    "The event log's own content ceiling, imported rather than copied, so a snapshot result seals into the content column without truncation and the timeline never has to declare a loss for a browser tool result.",
  ),
  SNAPSHOT_ELEMENTS_MAX: scalar(
    500,
    "elements",
    "The interactive-element census past which a snapshot stops being readable by anything.",
  ),
  EVALUATE_RESULT_MAX: scalar(
    CONTENT_PAYLOAD_PLAINTEXT_MAX,
    "bytes",
    "Same derivation as the snapshot ceiling, and the same constant.",
  ),
  LOCATOR_RESULT_MAX: scalar(
    CONTENT_PAYLOAD_PLAINTEXT_MAX,
    "bytes",
    "Same derivation as the snapshot ceiling, and the same constant.",
  ),
  CONSOLE_RING_ENTRIES: scalar(500, "entries", "One page load's worth of noise plus headroom."),
  CONSOLE_ENTRY_MAX: scalar(16_384, "bytes per entry", "So one stack trace cannot evict the ring."),
  CLIPBOARD_MAX: scalar(8_388_608, "bytes", "Across at most 100 items."),
  FULL_PAGE_CAPTURE_MAX: extent(
    4000,
    12_000,
    "Past this a full-page capture is a memory event, not a screenshot.",
  ),
  CAPTURE_AND_DOWNLOAD_BYTES: {
    measure: { kind: "deferred", owner: "the attachment ingest pipeline" },
    derivation:
      "Not a browser bound at all. The attachment ingest pipeline sets this ceiling, and minting a second one here would let the two drift.",
  },
  VIEWPORT_DEFAULT: extent(
    1280,
    720,
    "The deterministic box every pointer coordinate must fall inside.",
  ),
  VIEWPORT_MIN: extent(320, 240, "The bottom of the viewport override range."),
  VIEWPORT_MAX: extent(1920, 1200, "The top of the viewport override range."),
  PAGE_OPERATION_TIMEOUT_MS: scalar(
    30_000,
    "ms",
    "The ceiling any tool's own timeout argument may request.",
  ),
  VIEW_IDLE_TEARDOWN_MS: scalar(
    120_000,
    "ms",
    "A view whose pane has been closed this long is torn down and its partition released.",
  ),
  VIEW_RESIDENT_BUDGET_MB: scalar(
    400,
    "MB per view",
    "Exceeding it for two consecutive samples logs a diagnostic and, on a background view, tears the view down.",
  ),
};

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
