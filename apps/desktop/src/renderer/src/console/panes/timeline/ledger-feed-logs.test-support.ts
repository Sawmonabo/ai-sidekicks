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

import { EVENT_ID_STEM } from "../../bridge/scenarios/ledger-cast.js";
import { shellRowId } from "../../ledger/cards/index.js";
import { SessionStore, type ConsoleSessionEvent } from "../../store/index.js";

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
 * Two participants whose PREFERRED wheel step is the same, so which of them takes
 * it is decided by admission order and by nothing else.
 *
 * The collision is the instrument: with distinct preferred steps both orders agree
 * and the cases that use it would pass over either allocator.
 */
export const EARLY_JOINER = "participant-alba";
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

/** One run's id, so a case can name the chapter it expects a header for. */
export const TERMINAL_RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";
export const LIVE_RUN_ID = "019b793b-7b60-740e-8120-d1a4c1150112";

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

/**
 * A log with two participants, two event families, and a rollback boundary.
 *
 * Built for the narrowing cases, and shaped so the load-bearing rule can fail: the
 * boundary carries a DIFFERENT actor from the run it belongs to, so admitting the
 * agent's rows admits the boundary only if the filter's second pass does its job.
 * With one actor throughout, a filter that had dropped the boundary rule entirely
 * would still have passed.
 */
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
 * The row id the projection mints for one sequence of a session's log.
 *
 * DELEGATED, not restated. `shellRowId` is the composition the shell keys its rows
 * with, so asking it is what makes a case about a row and the projection that minted
 * that row incapable of disagreeing; a copy of the template here would drift and the
 * case would pass by finding nothing. The fixtures keep their own name for it because
 * every case in this family reads in that vocabulary.
 */
export function projectedRowId(sessionId: string, sequence: number): string {
  return shellRowId(sessionId, sequence);
}

/** The row id the projection mints for one sequence of the filterable log. */
export function filterableRowId(sequence: number): string {
  return projectedRowId(FILTERABLE_SESSION_ID, sequence);
}

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
