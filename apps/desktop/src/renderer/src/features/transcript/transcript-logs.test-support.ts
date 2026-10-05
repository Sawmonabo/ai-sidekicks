// The logs every transcript-feed case is driven over: pure store builders (a real
// `SessionStore` with a real batch applied) with no DOM. The harness that mounts a feed is
// `feed/components/TranscriptFeed.test-support.tsx`.
// Every event carries a real row id, because the hydrated-event read is keyed by it.

import { EVENT_ID_STEM } from "@fixtures/scenarios/transcript-states.js";
import { SessionStore } from "@renderer/store/session/session-store.js";

/** The session every fixture log belongs to. */
export const SESSION_ID = "session-transcript-feed";

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
export function transcriptFixtureStreamCursor(sequence: number): string {
  return `stream-position-${String(sequence)}`;
}

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
    })),
  );
  return sessionStore;
}

/**
 * A live run whose rows are tool rows, the only cards that carry a disclosure, so a case can
 * press a reader's expansion and watch the retained-state round trip out of the row and back.
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
        runId: LIVE_RUN_ID,
        toolName: `tool_${String(index)}`,
        toolCallId: `call-${String(index)}`,
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
      payload: {},
    })),
  );
  return sessionStore;
}
