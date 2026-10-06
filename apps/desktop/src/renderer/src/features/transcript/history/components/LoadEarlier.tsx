// The control at the window's head: reads the rows this window was never sent. It takes the
// feed's walk as a prop, so a composition with no read mounts no control. Like
// `JumpToLatest.tsx` it sits outside the scroll container. A button, not a scroll trigger:
// arriving at the top must not grow the log under someone passing through.

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { type EarlierHistoryPaging } from "../hooks/useEarlierHistory.js";

/** The walk whose state the control renders and whose page it asks for. */
export interface LoadEarlierAffordanceProps {
  readonly earlierHistory: EarlierHistoryPaging;
}

/**
 * The head control, or nothing.
 *
 * Nothing is the ordinary state: most windows open at the beginning of their log and every
 * walk ends exhausted. A refused read keeps the control so the refusal has somewhere to
 * render, and offers the press again.
 */
export function LoadEarlier(props: LoadEarlierAffordanceProps): React.JSX.Element | null {
  const { canLoadEarlier, isReading, refusal, loadEarlier } = props.earlierHistory;
  if (!canLoadEarlier && !isReading && refusal === undefined) {
    return null;
  }
  return (
    <div className="meridian-transcript-viewport__head">
      <button
        type="button"
        className="meridian-transcript-viewport__load-earlier"
        onClick={loadEarlier}
        // Disabled while a page is in flight rather than hidden, so the control does not vanish
        // under the pointer that just pressed it.
        disabled={!canLoadEarlier}
      >
        {isReading ? "Loading earlier entries…" : "Load earlier"}
      </button>
      {refusal === undefined ? null : <InlineRefusal code={refusal.code} detail={refusal.detail} />}
    </div>
  );
}
