// The logs every ledger-feed case is driven over.
//
// Split from the render harness beside it because the two are different jobs and
// only one of them needs a DOM: these are pure store builders — a real
// `SessionStore` with a real batch applied — and they are read by the pane's own
// unit cases, by the model's, and by the composed feed's alike. The harness that
// mounts a feed, stubs a box and presses a palette row is `LedgerFeedFixtures.test-support.tsx`'.
//
// EVERY EVENT CARRIES A REAL ROW ID. The hydrated-event read is keyed by it, so a
// store seeded without one holds rows nothing could ever ask about.

import { EVENT_ID_STEM } from "../../../bridge/scenarios/ledger-cast.js";
import { SessionStore } from "../../../store/index.js";

export const SESSION_ID = "session-ledger-feed";

/**
 * The wire instant of the row at one log position — one second apart, from one epoch.
 *
 * ONE EXPRESSION FOR THE WHOLE FAMILY'S FIXTURE CLOCK. Every ledger case reads a log
 * whose rows are a second apart, and every one of them used to spell that out for
 * itself: six byte-identical `at` helpers and four inlined copies of the same
 * `Date.UTC` call. Move the epoch — which a case wanting two sessions on different
 * days would — and ten sites have to move together; miss one and the ordering
 * assertions still pass while the chapter boundaries silently shift.
 *
 * `Date.UTC` rather than a parsed literal, for `ledger-cast.ts`' reason: `Date.parse`
 * reads a timezone-less stamp in the host's zone, so a fixture that parsed its own
 * spelling would be asking a reader to trust the one function this console bans.
 */
export function ledgerFixtureStampAt(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString();
}

/**
 * The daemon's opaque row id for the event at one log position.
 *
 * Every `ConsoleSessionEvent` carries one — the hydrated-event read is keyed by it —
 * so a store seeded without one holds rows nothing could ever ask about. Positional
 * here because these logs are generated, and distinct from `SESSION_ID` because the
 * two identify different things.
 *
 * The stem is the ledger scenario's, imported rather than restated: an id namespace
 * written twice is two namespaces the day one of them moves.
 */
export function ledgerFixtureEventId(sequence: number): string {
  return `${EVENT_ID_STEM}${String(sequence).padStart(4, "0")}`;
}

/**
 * The first of two participants whose PREFERRED wheel step is the same, so which of
 * them takes it is decided by admission order and by nothing else.
 *
 * The collision is the instrument: with distinct preferred steps both orders agree
 * and the cases that use this pair would pass over either allocator.
 */
export const EARLY_JOINER = "participant-alba";

/** The second of that pair — the one whose preferred step is already taken. */
export const LATE_JOINER = "participant-enzo";

/** A real store holding a log of `count` run events, oldest first. */
export function openSessionStoreWithLog(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      id: ledgerFixtureEventId(index),
      sessionId: SESSION_ID,
      sequence: index,
      kind: "run.running",
      occurredAt: ledgerFixtureStampAt(index),
      payload: { sessionId: SESSION_ID, runId: "019b793b-7b60-740e-8110-d1a4c1150111" },
    })),
  );
  return sessionStore;
}

/** A store whose join order and first-event order deliberately disagree. */
export function openStoreWhereJoinOrderIsNotEventOrder(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({
    cursor: -1,
    entities: [],
    participantJoinLog: [EARLY_JOINER, LATE_JOINER],
  });
  sessionStore.applyBatch([
    {
      id: ledgerFixtureEventId(0),
      sessionId: SESSION_ID,
      sequence: 0,
      kind: "user.message",
      occurredAt: ledgerFixtureStampAt(0),
      actorId: LATE_JOINER,
      payload: {},
    },
    {
      id: ledgerFixtureEventId(1),
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "user.message",
      occurredAt: ledgerFixtureStampAt(1),
      actorId: EARLY_JOINER,
      payload: {},
    },
  ]);
  return sessionStore;
}

/** A run that has ENDED, so a case can name the chapter it expects a header for. */
export const TERMINAL_RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";

/** A run still going, so a case can tell an open chapter from a closed one. */
export const LIVE_RUN_ID = "019b793b-7b60-740e-8120-d1a4c1150112";

/**
 * A session id the CONTRACT accepts, which the boundary arm's payload needs.
 *
 * The shared `SESSION_ID` above is a readable string, which every other fixture can
 * afford because their payloads are open records. A rollback boundary's is parsed
 * against the wire schema and dropped when it does not satisfy it, so this one
 * fixture pays for a real identifier rather than shipping a log whose boundary is
 * silently counted as unprojectable.
 */
export const FILTERABLE_SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";

/**
 * The row id the projection carries for one sequence of a log this file seeds.
 *
 * THE SAME VALUE THE EVENT CARRIES, because the projection copies it. It used to
 * delegate to a composition the shell minted from `(sessionId, sequence)`; the shell
 * now carries `ConsoleSessionEvent.id` verbatim, so the row id a case asks for is the
 * id the fixture stamped and the session is no longer part of it. The name stays
 * because every case in this family reads in that vocabulary.
 */
export function projectedRowId(sequence: number): string {
  return ledgerFixtureEventId(sequence);
}

/** The row id the projection carries for one sequence of the filterable log. */
export function filterableRowId(sequence: number): string {
  return projectedRowId(sequence);
}

/**
 * A log with two participants, two event families, and a rollback boundary.
 *
 * Built for the narrowing cases, and shaped so the load-bearing rule can fail: the
 * boundary carries a DIFFERENT actor from the run it belongs to, so admitting the
 * agent's rows admits the boundary only if the filter's second pass does its job.
 * With one actor throughout, a filter that had dropped the boundary rule entirely
 * would still have passed.
 */
export function openSessionStoreWithFilterableLog(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: FILTERABLE_SESSION_ID });
  sessionStore.initialise({
    cursor: -1,
    entities: [],
    participantJoinLog: [EARLY_JOINER, LATE_JOINER],
  });
  sessionStore.applyBatch([
    {
      id: ledgerFixtureEventId(0),
      sessionId: FILTERABLE_SESSION_ID,
      sequence: 0,
      kind: "run.running",
      occurredAt: ledgerFixtureStampAt(0),
      actorId: EARLY_JOINER,
      payload: { sessionId: FILTERABLE_SESSION_ID, runId: LIVE_RUN_ID },
    },
    {
      id: ledgerFixtureEventId(1),
      sessionId: FILTERABLE_SESSION_ID,
      sequence: 1,
      kind: "run.rolled_back",
      occurredAt: ledgerFixtureStampAt(1),
      actorId: LATE_JOINER,
      payload: {
        sessionId: FILTERABLE_SESSION_ID,
        runId: LIVE_RUN_ID,
        runVersion: 1,
        targetPosition: 0,
      },
    },
    {
      id: ledgerFixtureEventId(2),
      sessionId: FILTERABLE_SESSION_ID,
      sequence: 2,
      kind: "user.message",
      occurredAt: ledgerFixtureStampAt(2),
      actorId: LATE_JOINER,
      payload: {},
    },
  ]);
  return sessionStore;
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
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      id: ledgerFixtureEventId(index),
      sessionId: SESSION_ID,
      sequence: index,
      kind: "tool.invoked",
      occurredAt: ledgerFixtureStampAt(index),
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

/** A log of general rows, so no chapter is open and the cap may actually apply. */
export function openSessionStoreWithGeneralLog(count: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: -1, entities: [], participantJoinLog: [] });
  sessionStore.applyBatch(
    Array.from({ length: count }, (_unused, index) => ({
      id: ledgerFixtureEventId(index),
      sessionId: SESSION_ID,
      sequence: index,
      kind: "user.message",
      occurredAt: ledgerFixtureStampAt(index),
      payload: {},
    })),
  );
  return sessionStore;
}
