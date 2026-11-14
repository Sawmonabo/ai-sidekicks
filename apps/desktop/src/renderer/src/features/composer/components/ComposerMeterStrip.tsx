// The composer toolbar's row: the row of chips at its left, and at its right the cluster that
// never folds, Attach and the context ring drawn from a reading the caller has folded, so the
// toolbar over an open session and the composer's resting space draw the same box.

import type { ContextWindowReading } from "#renderer/store/session/events/context-window-reading.js";
import { ContextRing } from "../context-ring/ContextRing.js";

import "./ComposerToolbar.css";

/** What the meter strip draws. */
export interface ComposerMeterStripProps {
  /** The newest reading for the addressed run, or `undefined` while there is none. */
  readonly contextReading: ContextWindowReading | undefined;
  /** The row of chips, absent in the resting space. */
  readonly chips?: React.ReactNode;
  /** The Attach control, absent in the resting space. */
  readonly attach?: React.ReactNode;
}

/** The toolbar's row: its chips, Attach, and how full the conversation is. */
export function ComposerMeterStrip(props: ComposerMeterStripProps): React.JSX.Element {
  return (
    <div className="meridian-composer__toolbar">
      <div className="meridian-composer__toolbar-cluster">
        <div className="meridian-composer__chips">{props.chips}</div>
        <div className="meridian-composer__meters">
          {props.attach}
          <ContextRing reading={props.contextReading} />
        </div>
      </div>
    </div>
  );
}
