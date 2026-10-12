// The one line under the session header that says the window is catching up, or that it could
// not: a read failed (the session's own or one its screen depends on, such as the repo mounts
// read), or the window is behind for a cause a replay raises again, so no read is coming. Before
// the session's first read has landed a failure says the session could not load instead. It
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
  useSessionInitialized,
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

/**
 * `Catching up…`, `Couldn't catch up · Try again` or `Could not load this session · Try again`, or
 * nothing while the window is whole.
 */
export function SessionCatchUpLine(props: SessionCatchUpLineProps): React.JSX.Element | null {
  const clock = useClock();
  const isInitialized = useSessionInitialized(props.sessionStore);
  const degradedCause = useSessionDegradedCause(props.sessionStore);
  const isReplaying = useSessionStore(props.sessionStore, readIsReplaying);
  const lastReadFailed = useSessionStore(props.sessionStore, readLastReadFailed);
  const readFailureCount = useSessionStore(props.sessionStore, readReadFailureCount);
  const raisedAgainCauseCount = useSessionStore(props.sessionStore, readRaisedAgainCauseCount);
  const dependentReadFailed = useDependentReadFailed(props.sessionStore);
  const dependentFailedPassCount = useDependentReadFailedPassCount(props.sessionStore);
  const words = useCatchUpLineWords(
    standingWords({
      isInitialized,
      degradedCause,
      isReplaying,
      lastReadFailed,
      dependentReadFailed,
    }),
    clock,
  );
  if (words === undefined) {
    return null;
  }
  const failureWords = FAILURE_WORDS[words];
  const isFailed = failureWords !== undefined;
  return (
    // `Try again` beside the failure is not read out.
    <AnnouncedLine
      element="div"
      className="meridian-session-screen__catch-up"
      words={failureWords ?? "Catching up…"}
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
          {`${failureWords} · `}
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

/** What each failure says before its `Try again`; `Catching up…` has none. */
const FAILURE_WORDS: Readonly<Record<CatchUpWords, string | undefined>> = {
  "catching-up": undefined,
  "could-not-catch-up": "Couldn't catch up",
  "could-not-load": "Could not load this session",
};

/** What the line's words are decided from. */
interface CatchUpFacts {
  readonly isInitialized: boolean;
  readonly degradedCause: SessionDegradedCause | undefined;
  readonly isReplaying: boolean;
  readonly lastReadFailed: boolean;
  readonly dependentReadFailed: boolean;
}

/**
 * The words that stand now. A failed dependent read says it could not catch up whether or not
 * the session's own projection is whole. A window behind catches up while its replay runs, and
 * otherwise could not when its read failed or its cause is one a replay raises again, since no
 * read is coming for it. A failure before the first read has landed says the session could not
 * load, since there is nothing yet to catch up.
 */
function standingWords(facts: CatchUpFacts): CatchUpWords | undefined {
  const failure = facts.isInitialized ? "could-not-catch-up" : "could-not-load";
  if (facts.dependentReadFailed) {
    return failure;
  }
  const cause = facts.degradedCause;
  if (cause === undefined) {
    return undefined;
  }
  if (facts.isReplaying) {
    return "catching-up";
  }
  return facts.lastReadFailed || isRaisedAgainOnReplay(cause) ? failure : "catching-up";
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
