// The logs every ledger-feed case is driven over.
//
// Split from the render harness beside it because the two are different jobs and
// only one of them needs a DOM: these are pure store builders — a real
// `SessionStore` with a real batch applied — and they are read by the pane's own
// unit cases, by the model's, and by the composed feed's alike. The harness that
// mounts a feed, stubs a box and presses a palette row is
// `feed/components/TranscriptFeed.test-support.tsx`'.
//
// EVERY EVENT CARRIES A REAL ROW ID. The hydrated-event read is keyed by it, so a
// store seeded without one holds rows nothing could ever ask about.
import { EVENT_ID_STEM } from "../../../../../fixtures/scenarios/transcript-states.js";
import { SessionStore } from "@renderer/store/session/session-store.js";

export const SESSION_ID = "session-transcript-feed";

/**
 * The wire instant of the row at one log position — one second apart, from one epoch.
 *
 * ONE EXPRESSION FOR THE WHOLE FAMILY'S FIXTURE CLOCK. Every transcript case reads a log
 * whose rows are a second apart, and every one of them used to spell that out for
 * itself: six byte-identical `at` helpers and four inlined copies of the same
 * `Date.UTC` call. Move the epoch — which a case wanting two sessions on different
 * days would — and ten sites have to move together; miss one and the ordering
 * assertions still pass while the run group boundaries silently shift.
 *
 * `Date.UTC` rather than a parsed literal, because `Date.parse`
 * reads a timezone-less stamp in the host's zone, so a fixture that parsed its own
 * spelling would be asking a reader to trust the one function this console bans.
 */
export function transcriptFixtureStampAt(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString();
}

/**
 * The daemon's opaque row id for the event at one log position.
 *
 * Every `ProjectedSessionEvent` carries one — the hydrated-event read is keyed by it —
 * so a store seeded without one holds rows nothing could ever ask about. Positional
 * here because these logs are generated, and distinct from `SESSION_ID` because the
 * two identify different things.
 *
 * The stem is the transcript scenario's, imported rather than restated: an id namespace
 * written twice is two namespaces the day one of them moves.
 */
export function transcriptFixtureEventId(sequence: number): string {
  return `${EVENT_ID_STEM}${String(sequence).padStart(4, "0")}`;
}

/** A real store holding a log of `count` run events, oldest first. */
export function openSessionStoreWithFeedLog(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: -1, entities: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      id: transcriptFixtureEventId(index),
      sessionId: SESSION_ID,
      sequence: index,
      kind: "run.running",
      occurredAt: transcriptFixtureStampAt(index),
      payload: { sessionId: SESSION_ID, runId: "019b793b-7b60-740e-8110-d1a4c1150111" },
    })),
  );
  return sessionStore;
}

/** A run that has ENDED, so a case can name the run group it expects a header for. */
export const TERMINAL_RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";

/** A run still going, so a case can tell an open run group from a closed one. */
export const LIVE_RUN_ID = "019b793b-7b60-740e-8120-d1a4c1150112";

/**
 * The row id the projection carries for one sequence of a log this file seeds.
 *
 * THE SAME VALUE THE EVENT CARRIES, because the projection copies it. It used to
 * delegate to a composition the shell minted from `(sessionId, sequence)`; the shell
 * now carries `ProjectedSessionEvent.id` verbatim, so the row id a case asks for is the
 * id the fixture stamped and the session is no longer part of it. The name stays
 * because every case in this family reads in that vocabulary.
 */
export function projectedRowId(sequence: number): string {
  return transcriptFixtureEventId(sequence);
}

/**
 * A live run whose rows are tool rows, which are the ones that carry a disclosure.
 *
 * The only card in the shell that offers one, so it is the only row through which a
 * reader's expansion can be pressed at all — and therefore the only one that can show
 * the lease making the round trip out of the row and back.
 */
export function openSessionStoreWithToolRows(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: -1, entities: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      id: transcriptFixtureEventId(index),
      sessionId: SESSION_ID,
      sequence: index,
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

/** A log of general rows, so no run group is open and the cap may actually apply. */
export function openSessionStoreWithGeneralLog(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: -1, entities: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      id: transcriptFixtureEventId(index),
      sessionId: SESSION_ID,
      sequence: index,
      kind: "user.message",
      occurredAt: transcriptFixtureStampAt(index),
      payload: {},
    })),
  );
  return sessionStore;
}
