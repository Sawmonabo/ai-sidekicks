// The superseded band, as the one line that says what a rewind put behind it.
//
// WHAT WAS MISSING. `superseded-bands.ts` derives a band — the run, the epoch, the
// rewind cutoff, and every row past it — and the only thing that ever reached the
// screen from it was a per-row boolean. So a rewind of forty turns drew forty dimmed
// rows and said nowhere that they were one act, what turn the rewind landed on, or
// how many rows it moved. The band was a group in the model and a smear on screen.
//
// THE HEADER IS THE BAND'S ONLY CONTROL, and it is a disclosure and nothing else —
// `ChapterHeader`'s rule, for the same reason: which rows are in the band, which
// cutoff defined it and which epoch it belongs to are the model's answers, and a
// header that recomputed any of them would be a second answer to a settled question.
//
// AND IT OPENS SHOWING EVERYTHING. `superseded-bands.ts` states that a band's rows
// stay "present but visibly past" and that the ledger "dims a band rather than
// deleting one" — so the individual dims are what a person sees by default, and the
// fold is an OFFER laid over them rather than the state they start in. `isFolded`
// arrives `false` until somebody presses this control.
//
// EVERY PART IS A VALUE. The cutoff is the daemon's own `targetPosition` in mono,
// because it is the number a person reads back against the run's own positions; the
// row count is the console's own reading of the band it derived, so it is the
// proportional treatment and never the wire one.

import { DerivedFigure, Glyph, WireFigure, formatCount } from "../../../primitives/index.js";
import { type SupersededBand } from "./superseded-bands.js";

export interface SupersededBandRowProps {
  readonly band: SupersededBand;
  /** Whether the band's rows are folded away behind this header. */
  readonly isFolded: boolean;
  readonly onToggle: (band: SupersededBand) => void;
}

/** One rewound band, as a header. */
export function SupersededBandRow(props: SupersededBandRowProps): React.JSX.Element {
  const { band } = props;
  return (
    <div className="meridian-superseded-band">
      <Glyph name="rewind" title="Rewound by a rollback" />
      <span className="meridian-superseded-band__label">
        {"Superseded at turn "}
        <WireFigure value={String(band.targetPosition)} />
      </span>
      <span className="meridian-superseded-band__count">
        <DerivedFigure text={formatCount(band.rowIds.length)} />
        {band.rowIds.length === 1 ? " entry" : " entries"}
      </span>
      <button
        type="button"
        className="meridian-superseded-band__disclosure"
        aria-expanded={!props.isFolded}
        onClick={() => {
          props.onToggle(band);
        }}
      >
        <Glyph name={props.isFolded ? "chevron-right" : "chevron-down"} />
        {props.isFolded ? "Show" : "Fold"}
      </button>
    </div>
  );
}
