// The composer toolbar's strip of meters, drawn from a context reading the caller has folded, so
// the toolbar over an open session and the composer's resting space draw the same box.

import type { ContextWindowReading } from "#renderer/store/session/events/context-window-reading.js";
import { ContextRing } from "../context-ring/ContextRing.js";

import "./ComposerToolbar.css";

/** What the meter strip draws. */
export interface ComposerMeterStripProps {
  /** The newest reading for the addressed run, or `undefined` while there is none. */
  readonly contextReading: ContextWindowReading | undefined;
}

/** The toolbar's meters: how full the conversation is. */
export function ComposerMeterStrip(props: ComposerMeterStripProps): React.JSX.Element {
  return (
    <div className="meridian-composer__toolbar">
      <div className="meridian-composer__toolbar-cluster">
        <div className="meridian-composer__meters">
          <ContextRing reading={props.contextReading} />
        </div>
      </div>
    </div>
  );
}
