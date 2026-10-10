// Logs for cases about a run group: a run that ended, one still going, a system message, and two
// runs among messages, the live one followed by messages or ending the log, for the cases about
// where a fold leaves the reader. Each is shaped so a fold rule can fail over it. The session id,
// instants and row ids come from `features/transcript/logs.test-support.ts` so there is one
// fixture epoch.

import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { SessionStore } from "#renderer/store/session/store.js";
import {
  LIVE_RUN_ID,
  SESSION_ID,
  TERMINAL_RUN_ID,
  transcriptFixtureEventId,
  transcriptFixtureStampAt,
  transcriptFixtureStreamCursor,
} from "../logs.test-support.js";

/**
 * A store holding one run that ended and one that is still going, so a case can show that how a
 * run stands changes nothing about its fold.
 */
export function openSessionStoreWithTerminalRunGroup(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: -1, entities: [] });
  sessionStore.applyBatch([
    {
      id: transcriptFixtureEventId(0),
      sessionId: SESSION_ID,
      sequence: 0,
      cursor: transcriptFixtureStreamCursor(0),
      kind: "run.running",
      occurredAt: transcriptFixtureStampAt(0),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
      runStamp: { position: 0, epoch: 0 },
    },
    {
      id: transcriptFixtureEventId(1),
      sessionId: SESSION_ID,
      sequence: 1,
      cursor: transcriptFixtureStreamCursor(1),
      kind: "assistant.message",
      occurredAt: transcriptFixtureStampAt(1),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
      runStamp: { position: 1, epoch: 0 },
    },
    {
      id: transcriptFixtureEventId(2),
      sessionId: SESSION_ID,
      sequence: 2,
      cursor: transcriptFixtureStreamCursor(2),
      kind: "run.paused",
      occurredAt: transcriptFixtureStampAt(2),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
      runStamp: { position: 2, epoch: 0 },
    },
    {
      id: transcriptFixtureEventId(3),
      sessionId: SESSION_ID,
      sequence: 3,
      cursor: transcriptFixtureStreamCursor(3),
      kind: "run.completed",
      occurredAt: transcriptFixtureStampAt(3),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
      runStamp: { position: 3, epoch: 0 },
    },
    {
      id: transcriptFixtureEventId(4),
      sessionId: SESSION_ID,
      sequence: 4,
      cursor: transcriptFixtureStreamCursor(4),
      kind: "run.running",
      occurredAt: transcriptFixtureStampAt(4),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
      runStamp: { position: 0, epoch: 0 },
    },
    {
      id: transcriptFixtureEventId(5),
      sessionId: SESSION_ID,
      sequence: 5,
      cursor: transcriptFixtureStreamCursor(5),
      kind: "assistant.message",
      occurredAt: transcriptFixtureStampAt(5),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
      runStamp: { position: 1, epoch: 0 },
    },
  ]);
  return sessionStore;
}

/** A store whose one run is still live and carries a compaction system message. */
export function openSessionStoreWithSystemMessage(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: -1, entities: [] });
  sessionStore.applyBatch([
    {
      id: transcriptFixtureEventId(0),
      sessionId: SESSION_ID,
      sequence: 0,
      cursor: transcriptFixtureStreamCursor(0),
      kind: "run.running",
      occurredAt: transcriptFixtureStampAt(0),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
      runStamp: { position: 0, epoch: 0 },
    },
    {
      id: transcriptFixtureEventId(1),
      sessionId: SESSION_ID,
      sequence: 1,
      cursor: transcriptFixtureStreamCursor(1),
      kind: "usage.context_compacted",
      occurredAt: transcriptFixtureStampAt(1),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
      runStamp: { position: 1, epoch: 0 },
    },
    {
      id: transcriptFixtureEventId(2),
      sessionId: SESSION_ID,
      sequence: 2,
      cursor: transcriptFixtureStreamCursor(2),
      kind: "assistant.message",
      occurredAt: transcriptFixtureStampAt(2),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
      runStamp: { position: 2, epoch: 0 },
    },
  ]);
  return sessionStore;
}

/**
 * The log positions of `openSessionStoreWithRunsAmongMessages`: six messages, a run that ended,
 * three messages, a run still going, and three messages, so either run's header can be pressed
 * near the tail and a message stands between the two runs at the middle of the view.
 */
export const RUNS_AMONG_MESSAGES = {
  endedRunFirst: 6,
  endedRunLast: 14,
  betweenRunsFirst: 15,
  betweenRunsMiddle: 16,
  liveRunFirst: 18,
  liveRunLast: 26,
  eventCount: 30,
} as const;

/** A store holding `RUNS_AMONG_MESSAGES`: messages outside any run, and two runs of replies. */
export function openSessionStoreWithRunsAmongMessages(): SessionStore {
  return openSessionStoreWithRunsAt(RUNS_AMONG_MESSAGES);
}

/**
 * A store holding the runs among messages without the messages after the live run, so the live
 * run's rows end the log and opening it at the tail adds rows at the log's end.
 */
export function openSessionStoreWithLiveRunAtTail(): SessionStore {
  return openSessionStoreWithRunsAt({
    ...RUNS_AMONG_MESSAGES,
    eventCount: RUNS_AMONG_MESSAGES.liveRunLast + 1,
  });
}

/** Where a log of two runs among messages puts each run, and how many events it holds. */
interface RunPositions {
  readonly endedRunFirst: number;
  readonly endedRunLast: number;
  readonly liveRunFirst: number;
  readonly liveRunLast: number;
  readonly eventCount: number;
}

/** A store holding messages outside any run, and an ended and a live run at `positions`. */
function openSessionStoreWithRunsAt(positions: RunPositions): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: -1, entities: [] });
  sessionStore.applyBatch(
    Array.from({ length: positions.eventCount }, (_unused, index): ProjectedSessionEvent => {
      if (index >= positions.endedRunFirst && index <= positions.endedRunLast) {
        const position = index - positions.endedRunFirst;
        return runEventAt(
          index,
          TERMINAL_RUN_ID,
          position,
          position === 0
            ? "run.running"
            : index === positions.endedRunLast
              ? "run.completed"
              : "assistant.message",
        );
      }
      if (index >= positions.liveRunFirst && index <= positions.liveRunLast) {
        const position = index - positions.liveRunFirst;
        return runEventAt(
          index,
          LIVE_RUN_ID,
          position,
          position === 0 ? "run.running" : "assistant.message",
        );
      }
      return {
        id: transcriptFixtureEventId(index),
        sessionId: SESSION_ID,
        sequence: index,
        cursor: transcriptFixtureStreamCursor(index),
        kind: "user.message",
        occurredAt: transcriptFixtureStampAt(index),
        payload: { sessionId: SESSION_ID, actor: "user", message: `Message ${String(index)}` },
      };
    }),
  );
  return sessionStore;
}

/** The event at one log position, the `position`th of its run. */
function runEventAt(
  index: number,
  runId: string,
  position: number,
  kind: string,
): ProjectedSessionEvent {
  return {
    id: transcriptFixtureEventId(index),
    sessionId: SESSION_ID,
    sequence: index,
    cursor: transcriptFixtureStreamCursor(index),
    kind,
    occurredAt: transcriptFixtureStampAt(index),
    payload: { sessionId: SESSION_ID, runId },
    runStamp: { position, epoch: 0 },
  };
}
