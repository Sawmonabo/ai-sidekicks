// The one line under the session header that says the window is catching up, or that a read
// failed: the session's own read or one its screen depends on, such as the repo mounts read. It
// names no technical cause, which goes to the window's diagnostic capture, and `Try again` reads
// each failed read again; the screen never polls.

import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import {
  useDependentReadFailed,
  useSessionDegraded,
} from "#renderer/store/session/hooks/useSessionInitialized.js";
import { type SessionStoreState } from "#renderer/store/session/state.js";
import { type SessionStore } from "#renderer/store/session/session-store.js";
import { useCatchUpLineWords, type CatchUpWords } from "../hooks/useCatchUpLineWords.js";

/** What the catch-up line is handed: the session store and the retry callback. */
export interface SessionCatchUpLineProps {
  readonly sessionStore: SessionStore;
  /** Reads this session again, for the press on `Try again`, beside its failed dependent reads. */
  readonly onTryAgain: (sessionId: string) => void;
}

/** `Catching up…` or `Couldn't catch up · Try again`, or nothing while the window is whole. */
export function SessionCatchUpLine(props: SessionCatchUpLineProps): React.JSX.Element | null {
  const clock = useClock();
  const isBehind = useSessionDegraded(props.sessionStore);
  const lastReadFailed = useSessionStore(props.sessionStore, readLastReadFailed);
  const dependentReadFailed = useDependentReadFailed(props.sessionStore);
  const words = useCatchUpLineWords(
    standingWords(isBehind, lastReadFailed, dependentReadFailed),
    clock,
  );
  if (words === undefined) {
    return null;
  }
  return (
    <div className="meridian-session-screen__catch-up" role="status">
      {words === "could-not-catch-up" ? (
        <>
          {"Couldn't catch up · "}
          <TryAgainButton
            onPress={() => {
              props.sessionStore.failedDependentReads.retryFailed();
              props.onTryAgain(props.sessionStore.sessionId);
            }}
          />
        </>
      ) : (
        "Catching up…"
      )}
    </div>
  );
}

/**
 * The words that stand now. A failed dependent read says it could not catch up whether or not
 * the session's own projection is whole; otherwise the line follows the session's own reads.
 */
function standingWords(
  isBehind: boolean,
  lastReadFailed: boolean,
  dependentReadFailed: boolean,
): CatchUpWords | undefined {
  if (dependentReadFailed || (isBehind && lastReadFailed)) {
    return "could-not-catch-up";
  }
  return isBehind ? "catching-up" : undefined;
}

/** Whether the newest read of this session failed, whatever cause stands beside it. */
function readLastReadFailed(state: SessionStoreState): boolean {
  return state.lastReadFailed;
}
