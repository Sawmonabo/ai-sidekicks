// Logs for cases about a run group: a run that ended, one still going, a folded run group's
// messages, and a seam. Each is shaped so a fold rule can fail over it. The session id, instants
// and row ids come from `transcript-logs.test-support.ts` so there is one fixture epoch.

import { SessionStore } from "@renderer/store/session/session-store.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import {
  LIVE_RUN_ID,
  SESSION_ID,
  TERMINAL_RUN_ID,
  transcriptFixtureEventId,
  transcriptFixtureStampAt,
} from "./transcript-logs.test-support.js";

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
      kind: "run.running",
      occurredAt: transcriptFixtureStampAt(0),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: transcriptFixtureEventId(1),
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "assistant.message",
      occurredAt: transcriptFixtureStampAt(1),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: transcriptFixtureEventId(2),
      sessionId: SESSION_ID,
      sequence: 2,
      kind: "run.paused",
      occurredAt: transcriptFixtureStampAt(2),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: transcriptFixtureEventId(3),
      sessionId: SESSION_ID,
      sequence: 3,
      kind: "run.completed",
      occurredAt: transcriptFixtureStampAt(3),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: transcriptFixtureEventId(4),
      sessionId: SESSION_ID,
      sequence: 4,
      kind: "run.running",
      occurredAt: transcriptFixtureStampAt(4),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
    {
      id: transcriptFixtureEventId(5),
      sessionId: SESSION_ID,
      sequence: 5,
      kind: "assistant.message",
      occurredAt: transcriptFixtureStampAt(5),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
  ]);
  return sessionStore;
}

/** Message rows the finished run in `foldedMessageRunGroupLog` holds, all folded away. */
export const FOLDED_RUN_GROUP_MESSAGE_ROW_COUNT = 3;

/**
 * A finished run full of message rows, beside a live run holding a tool call.
 *
 * Shaped for the category filter: the finished run's members are `assistant_output` and the
 * live run's is `tool_activity`, so filtering to the first can only be satisfied from inside a
 * run group folded shut by default, and filtering to the second empties that run group.
 */
export function foldedMessageRunGroupLog(): readonly ProjectedSessionEvent[] {
  const messageRows = Array.from(
    { length: FOLDED_RUN_GROUP_MESSAGE_ROW_COUNT },
    (_unused, index) => ({
      id: transcriptFixtureEventId(index + 1),
      sessionId: SESSION_ID,
      sequence: index + 1,
      kind: "assistant.message",
      occurredAt: transcriptFixtureStampAt(index + 1),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    }),
  );
  const afterMessages = FOLDED_RUN_GROUP_MESSAGE_ROW_COUNT + 1;
  return [
    {
      id: transcriptFixtureEventId(0),
      sessionId: SESSION_ID,
      sequence: 0,
      kind: "run.running",
      occurredAt: transcriptFixtureStampAt(0),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    ...messageRows,
    {
      id: transcriptFixtureEventId(afterMessages),
      sessionId: SESSION_ID,
      sequence: afterMessages,
      kind: "run.completed",
      occurredAt: transcriptFixtureStampAt(afterMessages),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: transcriptFixtureEventId(afterMessages + 1),
      sessionId: SESSION_ID,
      sequence: afterMessages + 1,
      kind: "tool.invoked",
      occurredAt: transcriptFixtureStampAt(afterMessages + 1),
      payload: {
        sessionId: SESSION_ID,
        runId: LIVE_RUN_ID,
        toolName: "read_file",
        toolCallId: "call-live-0",
      },
    },
  ];
}

/**
 * A store whose one run is still live and carries a compaction seam.
 *
 * Live so a fold cannot hide the seam and make a seam case pass or fail for the fold's reasons.
 */
export function openSessionStoreWithSystemMessage(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: -1, entities: [] });
  sessionStore.applyBatch([
    {
      id: transcriptFixtureEventId(0),
      sessionId: SESSION_ID,
      sequence: 0,
      kind: "run.running",
      occurredAt: transcriptFixtureStampAt(0),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
    {
      id: transcriptFixtureEventId(1),
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "usage.context_compacted",
      occurredAt: transcriptFixtureStampAt(1),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
    {
      id: transcriptFixtureEventId(2),
      sessionId: SESSION_ID,
      sequence: 2,
      kind: "assistant.message",
      occurredAt: transcriptFixtureStampAt(2),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
  ]);
  return sessionStore;
}
