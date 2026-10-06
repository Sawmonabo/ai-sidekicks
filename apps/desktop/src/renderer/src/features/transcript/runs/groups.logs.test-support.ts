// Logs for cases about a run group: a run that ended, one still going, and a system message.
// Each is shaped so a fold rule can fail over it. The session id, instants and row ids come from
// `features/transcript/logs.test-support.ts` so there is one fixture epoch.

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
 * A store holding one run that ended and one that is still going.
 *
 * Two runs because the fold's rule is the difference between them: the ended run folds to its
 * header and receipt, the live one keeps every row on screen.
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
    },
    {
      id: transcriptFixtureEventId(1),
      sessionId: SESSION_ID,
      sequence: 1,
      cursor: transcriptFixtureStreamCursor(1),
      kind: "assistant.message",
      occurredAt: transcriptFixtureStampAt(1),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: transcriptFixtureEventId(2),
      sessionId: SESSION_ID,
      sequence: 2,
      cursor: transcriptFixtureStreamCursor(2),
      kind: "run.paused",
      occurredAt: transcriptFixtureStampAt(2),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: transcriptFixtureEventId(3),
      sessionId: SESSION_ID,
      sequence: 3,
      cursor: transcriptFixtureStreamCursor(3),
      kind: "run.completed",
      occurredAt: transcriptFixtureStampAt(3),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: transcriptFixtureEventId(4),
      sessionId: SESSION_ID,
      sequence: 4,
      cursor: transcriptFixtureStreamCursor(4),
      kind: "run.running",
      occurredAt: transcriptFixtureStampAt(4),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
    {
      id: transcriptFixtureEventId(5),
      sessionId: SESSION_ID,
      sequence: 5,
      cursor: transcriptFixtureStreamCursor(5),
      kind: "assistant.message",
      occurredAt: transcriptFixtureStampAt(5),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
  ]);
  return sessionStore;
}

/**
 * A store whose one run is still live and carries a compaction system message.
 *
 * Live so a fold cannot hide the system message and make its case pass or fail for the fold's
 * reasons.
 */
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
    },
    {
      id: transcriptFixtureEventId(1),
      sessionId: SESSION_ID,
      sequence: 1,
      cursor: transcriptFixtureStreamCursor(1),
      kind: "usage.context_compacted",
      occurredAt: transcriptFixtureStampAt(1),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
    {
      id: transcriptFixtureEventId(2),
      sessionId: SESSION_ID,
      sequence: 2,
      cursor: transcriptFixtureStreamCursor(2),
      kind: "assistant.message",
      occurredAt: transcriptFixtureStampAt(2),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
  ]);
  return sessionStore;
}
