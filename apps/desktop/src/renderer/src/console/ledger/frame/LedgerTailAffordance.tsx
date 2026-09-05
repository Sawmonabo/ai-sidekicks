// The "N new" pill, and the pin's own notice.
//
// Its own module for the one-component rule. It is the reading anchor's whole
// user-visible surface, which is why it reads better beside the anchor's promise than
// inside the composition that mounts it.

import { DerivedFigure, formatCount } from "../../primitives/index.js";
import type { LedgerViewportSnapshot } from "./viewport/index.js";

export interface LedgerTailAffordanceProps {
  readonly snapshot: LedgerViewportSnapshot;
  readonly onJumpToTail: () => void;
}

/**
 * Two facts and one act.
 *
 * `reading-anchor.ts`'s promise gives the reader two facts and one
 * act: rows arrived while they were reading, history is pinned, and the way back to
 * the tail. The pill appears only in `reading-with-new-rows`, because a pill
 * offering to jump to rows already on screen is noise; the pin notice appears
 * whenever history is pinned, because it explains why the log has stopped trimming.
 */
export function LedgerTailAffordance(props: LedgerTailAffordanceProps): React.JSX.Element | null {
  const { reading } = props.snapshot;
  if (reading.mode !== "reading-with-new-rows" && reading.pinnedRootCursor === undefined) {
    return null;
  }
  return (
    <div className="meridian-ledger-viewport__tail">
      {reading.pinnedRootCursor === undefined ? null : (
        <span className="meridian-ledger-viewport__pin" role="status">
          History is pinned. Nothing is being trimmed while you read.
        </span>
      )}
      {reading.mode === "reading-with-new-rows" ? (
        <button
          type="button"
          className="meridian-ledger-viewport__pill"
          onClick={props.onJumpToTail}
        >
          <DerivedFigure text={formatCount(reading.newRowCount)} />
          <span>new</span>
        </button>
      ) : null}
    </div>
  );
}
