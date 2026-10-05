// The "N new" pill: the way back to the tail the reading anchor shows a person.

import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import type { ViewportSnapshot } from "../viewport-snapshot.js";

/** Props for `JumpToLatest`. */
export interface JumpToLatestProps {
  readonly snapshot: ViewportSnapshot;
  readonly onJumpToTail: () => void;
}

/**
 * The way back to the tail. The pill appears only in `reading-with-new-rows`: a pill for rows
 * already on screen is noise.
 */
export function JumpToLatest(props: JumpToLatestProps): React.JSX.Element | null {
  const { reading } = props.snapshot;
  if (reading.mode !== "reading-with-new-rows") {
    return null;
  }
  return (
    <div className="meridian-transcript-viewport__tail">
      <button
        type="button"
        className="meridian-transcript-viewport__pill"
        onClick={props.onJumpToTail}
      >
        <DerivedFigure text={formatCount(reading.newRowCount)} />
        <span>new</span>
      </button>
    </div>
  );
}
