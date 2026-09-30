// The "N new" pill and the pin notice: everything the reading anchor shows a person.

import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import type { ViewportSnapshot } from "../viewport-snapshot.js";

/** Props for `JumpToLatest`. */
export interface JumpToLatestProps {
  readonly snapshot: ViewportSnapshot;
  readonly onJumpToTail: () => void;
}

/**
 * The way back to the tail. The pill appears only in `reading-with-new-rows` (a pill for rows
 * already on screen is noise); the pin notice appears whenever history is pinned, since it
 * explains why the log has stopped trimming.
 */
export function JumpToLatest(props: JumpToLatestProps): React.JSX.Element | null {
  const { reading } = props.snapshot;
  if (reading.mode !== "reading-with-new-rows" && reading.pinnedRootCursor === undefined) {
    return null;
  }
  return (
    <div className="meridian-transcript-viewport__tail">
      {reading.pinnedRootCursor === undefined ? null : (
        <span className="meridian-transcript-viewport__pin" role="status">
          History is pinned. Nothing is being trimmed while you read.
        </span>
      )}
      {reading.mode === "reading-with-new-rows" ? (
        <button
          type="button"
          className="meridian-transcript-viewport__pill"
          onClick={props.onJumpToTail}
        >
          <DerivedFigure text={formatCount(reading.newRowCount)} />
          <span>new</span>
        </button>
      ) : null}
    </div>
  );
}
