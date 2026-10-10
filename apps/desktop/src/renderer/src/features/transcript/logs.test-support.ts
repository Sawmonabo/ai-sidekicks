// The logs every transcript-feed case is driven over: pure store builders (a real
// `SessionStore` with a real batch applied) with no DOM, and a daemon log the store's history is
// read from. The harness that mounts a feed is `feed/components/TranscriptFeed.test-support.tsx`.
// Every event carries a real row id, because the hydrated-event read is keyed by it.

import { CONTENT_LENGTH_PAYLOAD_KEY } from "@ai-sidekicks/contracts/event/declared-variants";
import { EventCursorSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import {
  TranscriptReadResponseSchema,
  type TranscriptReadRequest,
} from "@ai-sidekicks/contracts/transcript/operations";
import type { TranscriptEventRow, TranscriptReadRow } from "@ai-sidekicks/contracts/transcript/row";

import { EVENT_ID_STEM } from "#fixtures/scenarios/transcript-states.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import type { TranscriptWindowEdge } from "#renderer/store/session/state.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript/page.js";

/** The paged session's whole log as the daemon holds it, and every read it was asked. */
export interface ScriptedTranscriptLog {
  /** `transcript.read` over the log: at or before `beforeCursor`, or after `afterCursor`. */
  readonly read: TranscriptPageRead;
  /** Every request the read was asked, in the order asked. */
  readonly requests: readonly TranscriptReadRequest[];
  /** Refuses the next read, as a daemon that could not serve it does. */
  readonly refuseNextRead: () => void;
}

/** The session every fixture log belongs to. */
export const SESSION_ID = "session-transcript-feed";

/** A session the read contract admits: its rows name the session by a UUID. */
export const PAGED_SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a6";

/**
 * The wire instant of the row at one log position: one second apart from one epoch, in one
 * place so moving the epoch cannot leave a stale copy that shifts run group boundaries.
 * `Date.UTC` because `Date.parse` reads a timezone-less stamp in the host's zone.
 */
export function transcriptFixtureStampAt(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString();
}

/**
 * The daemon's opaque row id for the event at one log position. Positional because these logs
 * are generated. The stem is the transcript scenario's, imported so the namespace lives once.
 */
export function transcriptFixtureEventId(sequence: number): string {
  return `${EVENT_ID_STEM}${String(sequence).padStart(4, "0")}`;
}

/**
 * The position the session's stream delivered the event at one log position, the cursor a link
 * to that message names. Not the row id, so a lookup that confused the two would find nothing.
 */
export function transcriptFixtureStreamCursor(sequence: number): EventCursor {
  return EventCursorSchema.parse(`stream-position-${String(sequence)}`);
}

/** The length a tool row's unread body is counted at. */
const TOOL_ROW_BODY_LENGTH = 64;

/** A run that has ENDED, so a case can name the run group it expects a header for. */
export const TERMINAL_RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";

/** A run still going, so a case can tell an open run group from a closed one. */
export const LIVE_RUN_ID = "019b793b-7b60-740e-8120-d1a4c1150112";

/** A real store holding a log of `count` run events, oldest first. */
export function openSessionStoreWithFeedLog(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: -1, entities: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      id: transcriptFixtureEventId(index),
      sessionId: SESSION_ID,
      sequence: index,
      cursor: transcriptFixtureStreamCursor(index),
      kind: "run.running",
      occurredAt: transcriptFixtureStampAt(index),
      payload: { sessionId: SESSION_ID, runId: TERMINAL_RUN_ID },
      runStamp: { position: index, epoch: 0 },
    })),
  );
  return sessionStore;
}

/**
 * A log of tool rows outside any run, each named `tool_<position>`, so no run group clips them
 * and a case can read a drawn row's place in the log from its name. Each counts a body the log has
 * not read, so each draws its fold control.
 */
export function openSessionStoreWithToolRows(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: -1, entities: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      id: transcriptFixtureEventId(index),
      sessionId: SESSION_ID,
      sequence: index,
      cursor: transcriptFixtureStreamCursor(index),
      kind: "tool.invoked",
      occurredAt: transcriptFixtureStampAt(index),
      payload: {
        sessionId: SESSION_ID,
        toolName: `tool_${String(index)}`,
        toolCallId: `call-${String(index)}`,
        [CONTENT_LENGTH_PAYLOAD_KEY]: TOOL_ROW_BODY_LENGTH,
      },
    })),
  );
  return sessionStore;
}

/**
 * A log of general rows, so no run group is open and the cap may actually apply. Each event
 * carries the cursor the stream delivered it at.
 */
export function openSessionStoreWithGeneralLog(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: -1, entities: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      id: transcriptFixtureEventId(index),
      sessionId: SESSION_ID,
      sequence: index,
      cursor: transcriptFixtureStreamCursor(index),
      kind: "user.message",
      occurredAt: transcriptFixtureStampAt(index),
      payload: { message: "user.message" },
    })),
  );
  return sessionStore;
}

/** The message at one log position of the paged session, as `transcript.read` serves it. */
export function transcriptReadRowAt(index: number): TranscriptReadRow {
  return {
    kind: "general",
    id: transcriptFixtureEventId(index),
    sessionId: PAGED_SESSION_ID as SessionId,
    sequence: index,
    cursor: transcriptFixtureStreamCursor(index) as EventCursor,
    category: "interactive_request",
    type: "user.message",
    timestamp: transcriptFixtureStampAt(index),
    payload: { message: "user.message" },
    content: { status: "unavailable", reason: "absent" },
  };
}

/**
 * A row projected from the log as `transcript.read` serves it: with its event's body, or `absent`
 * where its event carries none, as the daemon reads an event with nothing stored beside it.
 */
export function readRowOf(row: TranscriptEventRow): TranscriptReadRow {
  return { ...row, content: row.content ?? { status: "unavailable", reason: "absent" } };
}

/** The message at one log position of the paged session, as the stream delivers it. */
export function pagedSessionEventAt(index: number): ProjectedSessionEvent {
  return {
    id: transcriptFixtureEventId(index),
    sessionId: PAGED_SESSION_ID,
    sequence: index,
    cursor: transcriptFixtureStreamCursor(index),
    kind: "user.message",
    occurredAt: transcriptFixtureStampAt(index),
    payload: { message: "user.message" },
  };
}

/**
 * A real store of the paged session holding its rows from `firstIndex` through `lastIndex`, each
 * as `eventAt` gives it (a message, unless given), as an opening read leaves it, with
 * `transcriptHead` before them (none, when not given).
 */
export function openPagedSessionStore(
  firstIndex: number,
  lastIndex: number,
  transcriptHead?: TranscriptWindowEdge,
  eventAt: (index: number) => ProjectedSessionEvent = pagedSessionEventAt,
): SessionStore {
  const sessionStore = new SessionStore({ sessionId: PAGED_SESSION_ID });
  sessionStore.initialize({
    cursor: lastIndex,
    streamAfterCursor: transcriptFixtureStreamCursor(lastIndex),
    entities: [],
    transcript: Array.from({ length: lastIndex - firstIndex + 1 }, (_unused, offset) =>
      eventAt(firstIndex + offset),
    ),
    ...(transcriptHead === undefined ? {} : { transcriptHead }),
  });
  return sessionStore;
}

/**
 * The paged session's rows at positions `0` through `rowCount - 1`, each as `rowAt` serves it (a
 * message, unless given), read as the daemon reads them: up to `limit` rows, oldest to newest,
 * nearest the cursor, or from the log's start with no cursor, with the next cursor and whether
 * rows lie past it. A cursor naming no row is refused.
 */
export function scriptedTranscriptLog(
  rowCount: number,
  rowAt: (index: number) => TranscriptReadRow = transcriptReadRowAt,
): ScriptedTranscriptLog {
  const indexByCursor = new Map(
    Array.from({ length: rowCount }, (_unused, index) => [
      transcriptFixtureStreamCursor(index),
      index,
    ]),
  );
  const requests: TranscriptReadRequest[] = [];
  let refusesNextRead = false;
  const read: TranscriptPageRead = (request) => {
    requests.push(request);
    const limit = request.limit ?? rowCount;
    const beforeIndex =
      request.beforeCursor === undefined ? undefined : indexByCursor.get(request.beforeCursor);
    const afterIndex =
      request.afterCursor === undefined ? undefined : indexByCursor.get(request.afterCursor);
    const namesNoRow =
      (request.beforeCursor !== undefined && beforeIndex === undefined) ||
      (request.afterCursor !== undefined && afterIndex === undefined);
    if (refusesNextRead || namesNoRow) {
      refusesNextRead = false;
      return Promise.resolve({
        status: "refused",
        refusal: { code: "unscripted", detail: "No page there.", origin: "test" },
      });
    }
    const firstIndex =
      beforeIndex !== undefined
        ? Math.max(0, beforeIndex - limit + 1)
        : afterIndex === undefined
          ? 0
          : afterIndex + 1;
    const lastIndex =
      beforeIndex === undefined ? Math.min(rowCount - 1, firstIndex + limit - 1) : beforeIndex;
    const entries = Array.from({ length: lastIndex - firstIndex + 1 }, (_unused, offset) =>
      rowAt(firstIndex + offset),
    );
    const hasMore = beforeIndex === undefined ? lastIndex < rowCount - 1 : firstIndex > 0;
    const nextCursor =
      beforeIndex === undefined
        ? transcriptFixtureStreamCursor(lastIndex)
        : transcriptFixtureStreamCursor(firstIndex - 1);
    return Promise.resolve({
      status: "served",
      value: TranscriptReadResponseSchema.parse(
        hasMore ? { entries, hasMore, nextCursor } : { entries, hasMore },
      ),
    });
  };
  return {
    read,
    requests,
    refuseNextRead: () => {
      refusesNextRead = true;
    },
  };
}
