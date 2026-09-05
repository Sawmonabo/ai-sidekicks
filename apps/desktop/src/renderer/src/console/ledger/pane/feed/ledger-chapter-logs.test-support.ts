// The logs a case needs when it is about a CHAPTER — a run that ended, a run that is
// still going, a folded chapter's messages, and a seam.
//
// SPLIT FROM `ledger-feed-logs.test-support.ts`, which keeps the fixture vocabulary
// and the plain logs. The two files hold two subjects: a case about the cap, a
// filter, or a join order needs a log and nothing else, while every log here is
// shaped so a FOLD rule can fail over it — two lanes rather than one, a boundary with
// a different actor from its run, a receipt that has to stay under its header. Kept
// in one file the pile was over four hundred lines and a reader looking for the
// terminal-chapter log met eight builders on the way.
//
// The session id, the instants and the row ids are still that module's. A log written
// against its own clock would be a second fixture epoch, which is the thing a shared
// stamp exists to prevent.

import { SessionStore, type ConsoleSessionEvent } from "../../../store/index.js";
import {
  LIVE_RUN_ID,
  SESSION_ID,
  TERMINAL_RUN_ID,
  ledgerFixtureEventId,
  ledgerFixtureStampAt,
} from "./ledger-feed-logs.test-support.js";

/**
 * A store holding one run that ENDED and one that is still going.
 *
 * Two lanes rather than one because the fold's rule is a difference between them:
 * the terminal chapter draws a header and folds to it and its receipt, the live one
 * draws none and keeps every row on screen. A single-lane log would pass over a fold
 * that folded everything.
 */
export function openSessionStoreWithTerminalChapter(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch([
    {
      id: ledgerFixtureEventId(0),
      sessionId: SESSION_ID,
      sequence: 0,
      kind: "run.running",
      occurredAt: ledgerFixtureStampAt(0),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: ledgerFixtureEventId(1),
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "assistant.message",
      occurredAt: ledgerFixtureStampAt(1),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: ledgerFixtureEventId(2),
      sessionId: SESSION_ID,
      sequence: 2,
      kind: "run.paused",
      occurredAt: ledgerFixtureStampAt(2),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: ledgerFixtureEventId(3),
      sessionId: SESSION_ID,
      sequence: 3,
      kind: "run.completed",
      occurredAt: ledgerFixtureStampAt(3),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: ledgerFixtureEventId(4),
      sessionId: SESSION_ID,
      sequence: 4,
      kind: "run.running",
      occurredAt: ledgerFixtureStampAt(4),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
    {
      id: ledgerFixtureEventId(5),
      sessionId: SESSION_ID,
      sequence: 5,
      kind: "assistant.message",
      occurredAt: ledgerFixtureStampAt(5),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
  ]);
  return sessionStore;
}

/** Message rows the finished run in `foldedMessageChapterLog` holds, all folded away. */
export const FOLDED_CHAPTER_MESSAGE_ROW_COUNT = 3;

/**
 * A finished run full of message rows, beside a live run holding a tool call.
 *
 * Shaped for the narrowing's ordering and for nothing else. The finished run's
 * members are `assistant_output` and the live run's is `tool_activity`, so the two
 * families name the two chapters: narrowing to the first can only be satisfied from
 * inside a chapter that is folded shut by default, and narrowing to the second
 * empties that chapter entirely. A single-family log would pass over a narrowing
 * that never looked inside a fold at all.
 */
export function foldedMessageChapterLog(): readonly ConsoleSessionEvent[] {
  const messageRows = Array.from(
    { length: FOLDED_CHAPTER_MESSAGE_ROW_COUNT },
    (_unused, index) => ({
      id: ledgerFixtureEventId(index + 1),
      sessionId: SESSION_ID,
      sequence: index + 1,
      kind: "assistant.message",
      occurredAt: ledgerFixtureStampAt(index + 1),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    }),
  );
  const afterMessages = FOLDED_CHAPTER_MESSAGE_ROW_COUNT + 1;
  return [
    {
      id: ledgerFixtureEventId(0),
      sessionId: SESSION_ID,
      sequence: 0,
      kind: "run.running",
      occurredAt: ledgerFixtureStampAt(0),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    ...messageRows,
    {
      id: ledgerFixtureEventId(afterMessages),
      sessionId: SESSION_ID,
      sequence: afterMessages,
      kind: "run.completed",
      occurredAt: ledgerFixtureStampAt(afterMessages),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
    },
    {
      id: ledgerFixtureEventId(afterMessages + 1),
      sessionId: SESSION_ID,
      sequence: afterMessages + 1,
      kind: "tool.invoked",
      occurredAt: ledgerFixtureStampAt(afterMessages + 1),
      payload: {
        sessionId: SESSION_ID,
        runId: LIVE_RUN_ID,
        toolName: "read_file",
        toolCallId: "call-live-0",
      },
    },
  ];
}

/** That log, in a real store. */
export function openSessionStoreWithFoldedMessageChapter(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch([...foldedMessageChapterLog()]);
  return sessionStore;
}

/**
 * A store whose one run is still live and carries a compaction seam.
 *
 * Live on purpose: the seam row and the chapter fold are two different dispatches in
 * the same renderer, and a seam inside a folded chapter would be hidden by the fold
 * rather than drawn — which would make a case about the seam pass or fail for the
 * fold's reasons.
 */
export function openSessionStoreWithSeam(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch([
    {
      id: ledgerFixtureEventId(0),
      sessionId: SESSION_ID,
      sequence: 0,
      kind: "run.running",
      occurredAt: ledgerFixtureStampAt(0),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
    {
      id: ledgerFixtureEventId(1),
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "usage.context_compacted",
      occurredAt: ledgerFixtureStampAt(1),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
    {
      id: ledgerFixtureEventId(2),
      sessionId: SESSION_ID,
      sequence: 2,
      kind: "assistant.message",
      occurredAt: ledgerFixtureStampAt(2),
      payload: { sessionId: SESSION_ID, runId: LIVE_RUN_ID },
    },
  ]);
  return sessionStore;
}
