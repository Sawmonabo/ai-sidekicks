// The act at the window's head: read the rows this user was never sent.
//
// SYMMETRIC WITH `JumpToLatest.tsx`, and the symmetry is the design rather
// than a coincidence. The tail affordance is the way back to rows that arrived while
// somebody was reading; this is the way back to rows that were never delivered at all,
// and both sit outside the scroll container at the end of the log they are about, so
// neither is a row and neither moves when the window does.
//
// OFFERED ONLY WHILE THERE IS SOMETHING TO READ. An absence names its cause, which is
// met here by the control's own absence being the ordinary case: a window that opens at
// the beginning of the log has no earlier rows, and a control that offered to fetch them
// would promise a read that answers nothing. What that rule does apply to is the
// REFUSAL, which is rendered inline
// on the control through the console's one refusal renderer rather than as a sentence
// this file wrote.
//
// IT OWNS THE WALK, TOO. It takes the page read as a prop and holds the walk's hook, so
// a composition with no read mounts no control and runs no walk.
//
// AND IT IS A BUTTON, NOT A SCROLL TRIGGER. Reading to the top of a window is not an
// instruction to fetch history — it is what a reader does on the way to the oldest row
// they have — and a fetch fired by arriving there would grow the log under somebody
// who was only passing through, on a walk with no end while the log has one.

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type EarlierPageRead } from "../earlier-history-reader.js";
import { useEarlierHistory } from "../hooks/useEarlierHistory.js";

export interface LoadEarlierAffordanceProps {
  readonly sessionStore: SessionStore;
  /** The read a page is fetched with. A composition with none mounts no control. */
  readonly readEarlierPage: EarlierPageRead;
}

/**
 * The head control, or nothing.
 *
 * Nothing is the ordinary state: most windows open at the beginning of their log, and
 * every walk ends exhausted. The one case that renders without an offer is a refused
 * read — the control stays so the refusal has somewhere to be, and the press is
 * offered again beside it, because a transport failure is exactly the kind a second
 * attempt settles.
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
        // Disabled while a page is in flight rather than hidden, so the control does
        // not vanish under the pointer that just pressed it. The reader drops a second
        // press anyway; this is what makes that legible instead of silent.
        disabled={!canLoadEarlier}
      >
        {isReading ? "Loading earlier entries…" : "Load earlier"}
      </button>
      {refusal === undefined ? null : <InlineRefusal code={refusal.code} detail={refusal.detail} />}
    </div>
  );
}
