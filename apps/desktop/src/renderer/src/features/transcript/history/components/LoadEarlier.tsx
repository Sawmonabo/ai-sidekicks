// The control at the window's head: reads the rows this window was never sent. It takes the
// page read as a prop, so a composition with no read mounts no control and no walk. Like
// `JumpToLatest.tsx` it sits outside the scroll container. A button, not a scroll trigger:
// arriving at the top must not grow the log under someone passing through.

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type EarlierPageRead } from "../earlier-history-reader.js";
import { useEarlierHistory } from "../hooks/useEarlierHistory.js";

/** The session whose earlier rows the control reads, and the read that fetches a page. */
export interface LoadEarlierAffordanceProps {
  readonly sessionStore: SessionStore;
  /** The read a page is fetched with. A composition with none mounts no control. */
  readonly readEarlierPage: EarlierPageRead;
}

/**
 * The head control, or nothing.
 *
 * Nothing is the ordinary state: most windows open at the beginning of their log and every
 * walk ends exhausted. A refused read keeps the control so the refusal has somewhere to
 * render, and offers the press again.
 */
export function LoadEarlier(props: LoadEarlierAffordanceProps): React.JSX.Element | null {
  const { canLoadEarlier, isReading, refusal, loadEarlier } = useEarlierHistory(
    props.sessionStore,
    props.readEarlierPage,
  );
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
