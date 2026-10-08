// The one line under the session header that says the window is catching up, or that it could
// not: a read failed (the session's own or one its screen depends on, such as the repo mounts
// read), or the window is behind for a cause a replay raises again, so no read is coming. It
// names no technical cause, which goes to the window's diagnostic capture, and `Try again` reads
// each failed read and the session again; the screen never polls.

import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import {
  isRaisedAgainOnReplay,
  type SessionDegradedCause,
} from "#renderer/store/session/degradation.js";
import {
  useDependentReadFailed,
  useDependentReadFailedPassCount,
  useSessionDegradedCause,
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
  const degradedCause = useSessionDegradedCause(props.sessionStore);
  const isReplaying = useSessionStore(props.sessionStore, readIsReplaying);
  const lastReadFailed = useSessionStore(props.sessionStore, readLastReadFailed);
  const readFailureCount = useSessionStore(props.sessionStore, readReadFailureCount);
  const raisedAgainCauseCount = useSessionStore(props.sessionStore, readRaisedAgainCauseCount);
  const dependentReadFailed = useDependentReadFailed(props.sessionStore);
  const dependentFailedPassCount = useDependentReadFailedPassCount(props.sessionStore);
  const words = useCatchUpLineWords(
    standingWords({ degradedCause, isReplaying, lastReadFailed, dependentReadFailed }),
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
      // A `Try again` that fails again leaves these words standing; each failure is said, a read
      // that failed or a replay that failed on the same row. The counts only grow, so a read
      // landing beside a standing failure says nothing.
      attempt={
        isFailed
          ? [readFailureCount, raisedAgainCauseCount, dependentFailedPassCount].join(":")
          : undefined
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

/** What the line's words are decided from. */
interface CatchUpFacts {
  readonly degradedCause: SessionDegradedCause | undefined;
  readonly isReplaying: boolean;
  readonly lastReadFailed: boolean;
  readonly dependentReadFailed: boolean;
}

/**
 * The words that stand now. A failed dependent read says it could not catch up whether or not
 * the session's own projection is whole. A window behind catches up while its replay runs, and
 * otherwise could not when its read failed or its cause is one a replay raises again, since no
 * read is coming for it.
 */
function standingWords(facts: CatchUpFacts): CatchUpWords | undefined {
  if (facts.dependentReadFailed) {
    return "could-not-catch-up";
  }
  const cause = facts.degradedCause;
  if (cause === undefined) {
    return undefined;
  }
  if (facts.isReplaying) {
    return "catching-up";
  }
  return facts.lastReadFailed || isRaisedAgainOnReplay(cause)
    ? "could-not-catch-up"
    : "catching-up";
}

function readIsReplaying(state: SessionStoreState): boolean {
  return state.isReplaying;
}

function readLastReadFailed(state: SessionStoreState): boolean {
  return state.lastReadFailed;
}

function readReadFailureCount(state: SessionStoreState): number {
  return state.readFailureCount;
}

function readRaisedAgainCauseCount(state: SessionStoreState): number {
  return state.raisedAgainCauseCount;
}
