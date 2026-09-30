// The one line under the session header that says the window is catching up.
//
// While the window repairs a hole in what it received, or a read it depends on has
// failed, this says so once, and nothing else on the screen repeats it. It names no
// technical cause: the cause goes to the window's diagnostic capture, where the session
// store's entry records it. A failed read reads `Couldn't catch up`, and `Try again`
// reads again; the window's own refresh on focus and on reconnect reads again too, so
// the screen never polls.

import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import { useSessionStore } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { useSessionDegraded } from "@renderer/store/session/hooks/useSessionInitialized.js";
import { type SessionStoreState } from "@renderer/store/session/session-state.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { useCatchUpLineShown } from "../hooks/useCatchUpLineShown.js";

export interface SessionCatchUpLineProps {
  readonly sessionStore: SessionStore;
  /** Reads this session again, for the press on `Try again`. */
  readonly onTryAgain: (sessionId: string) => void;
}

/** `Catching up…` or `Couldn't catch up · Try again`, or nothing while the window is whole. */
export function SessionCatchUpLine(props: SessionCatchUpLineProps): React.JSX.Element | null {
  const clock = useClock();
  const isBehind = useSessionDegraded(props.sessionStore);
  const lastReadFailed = useSessionStore(props.sessionStore, readLastReadFailed);
  const isShown = useCatchUpLineShown(isBehind, clock);
  if (!isShown) {
    return null;
  }
  return (
    <div className="meridian-session-screen__catch-up" role="status">
      {lastReadFailed ? (
        <>
          {"Couldn't catch up · "}
          <button
            type="button"
            className="meridian-action-button meridian-action-button--small meridian-action-button--outline"
            onClick={() => {
              props.onTryAgain(props.sessionStore.sessionId);
            }}
          >
            Try again
          </button>
        </>
      ) : (
        "Catching up…"
      )}
    </div>
  );
}

/** Whether the newest read of this session failed, whatever cause stands beside it. */
function readLastReadFailed(state: SessionStoreState): boolean {
  return state.lastReadFailed;
}
