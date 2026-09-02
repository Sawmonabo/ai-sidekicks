// What arrived, against what was declared — one meter, for both cards.
//
// `Spec-023 §Console Design (Meridian)` 12.6 requires an in-flight row to show
// received bytes AGAINST the declared total, and the browser family produces two
// kinds of object that can be in flight: a capture and a download. The bytes went
// through one pipeline, `artifact-ingest.ts` gives them one state vocabulary, and
// this is the third and last piece of that seam — the RENDERING, which was written
// twice before it was written here.
//
// Two copies of a progress bar is not a cosmetic problem. The bar carries the
// accessible value pair (`aria-valuenow` against `aria-valuemax`), and a second copy
// is a second place for that pair to disagree with the figure printed under it —
// which is the one reading a person uses to tell a stalled upload from a slow one.
//
// The label is the only thing that differs between the two callers, so it is the
// only prop that names them: everything else is the same fact about the same
// pipeline.

import {
  formatIngestProgress,
  ingestFillWidth,
  isIngestRangeDeterminate,
} from "./artifact-ingest.js";
import { WireFigure } from "../primitives/index.js";

export interface BrowserIngestMeterProps {
  /** What is being ingested, for the bar's accessible name. */
  readonly label: string;
  readonly receivedByteLength: number;
  readonly declaredByteLength: number;
}

/**
 * The bar's value attributes, which are two different sets rather than one set with
 * a hole in it.
 *
 * A progressbar carrying no `aria-valuenow` is INDETERMINATE under WAI-ARIA, which is
 * exactly the state an undeclared total leaves this bar in — and it is the only
 * honest one, because the alternative the component shipped was a `valuenow` past its
 * own `valuemax`, a range assistive technology cannot place and a reading no operator
 * could act on. The determinate arm keeps the numeric pair; the indeterminate arm
 * says in words what arrived and that the total is not known, through the same
 * sentence printed under the bar so the two readings cannot disagree.
 */
function meterValueAttributes(props: BrowserIngestMeterProps): React.AriaAttributes {
  if (!isIngestRangeDeterminate(props.receivedByteLength, props.declaredByteLength)) {
    return {
      "aria-valuetext": `${formatIngestProgress(props.receivedByteLength, props.declaredByteLength)} received`,
    };
  }
  return {
    "aria-valuenow": props.receivedByteLength,
    "aria-valuemax": props.declaredByteLength,
  };
}

export function BrowserIngestMeter(props: BrowserIngestMeterProps): React.JSX.Element {
  return (
    <>
      <div
        className="meridian-browser-meter"
        role="progressbar"
        aria-label={props.label}
        aria-valuemin={0}
        {...meterValueAttributes(props)}
      >
        <div
          className="meridian-browser-meter__fill"
          style={{
            inlineSize: ingestFillWidth(props.receivedByteLength, props.declaredByteLength),
          }}
        />
      </div>
      <p className="meridian-browser-card__note">
        {/* The figure goes through the console's one formatter and carries the raw
            byte count on its title, which is what `WireFigure` is for: the scaled
            reading is what a person reads, and the exact one is still reachable. */}
        <WireFigure
          value={formatIngestProgress(props.receivedByteLength, props.declaredByteLength)}
          title={String(props.receivedByteLength)}
        />{" "}
        received.
      </p>
    </>
  );
}
