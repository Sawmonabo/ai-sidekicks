// The one line under the session header that says the window is catching up, or that a read
// failed: the session's own read or one its screen depends on, such as the repo mounts read. It
// names no technical cause, which goes to the window's diagnostic capture, and `Try again` reads
// each failed read again; the screen never polls.

import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import {
  useDependentReadFailed,
  useDependentReadFailedPassCount,
  useSessionDegraded,
} from "#renderer/store/session/hooks/useSessionInitialized.js";
import { type SessionStoreState } from "#renderer/store/session/state.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { useCatchUpLineWords, type CatchUpWords } from "../hooks/useCatchUpLineWords.js";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";

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
  const readFailureCount = useSessionStore(props.sessionStore, readReadFailureCount);
  const dependentReadFailed = useDependentReadFailed(props.sessionStore);
  const dependentFailedPassCount = useDependentReadFailedPassCount(props.sessionStore);
  const words = useCatchUpLineWords(
    standingWords(isBehind, lastReadFailed, dependentReadFailed),
    clock,
  );
  if (words === undefined) {
    return null;
  }
  const isFailed = words === "could-not-catch-up";
  return (
    // `Try again` beside the failure is not read out.
    <AnnouncedLine
      element="div"
      className="meridian-session-screen__catch-up"
      words={isFailed ? "Couldn't catch up" : "Catching up…"}
      politeness={isFailed ? "assertive" : "polite"}
      // A `Try again` that fails again leaves these words standing; each failure is said. Both
      // counts only grow, so a read landing beside a standing failure says nothing.
      attempt={
        isFailed ? `${String(readFailureCount)}:${String(dependentFailedPassCount)}` : undefined
      }
    >
      {isFailed ? (
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
    </AnnouncedLine>
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

function readLastReadFailed(state: SessionStoreState): boolean {
  return state.lastReadFailed;
}

function readReadFailureCount(state: SessionStoreState): number {
  return state.readFailureCount;
}
