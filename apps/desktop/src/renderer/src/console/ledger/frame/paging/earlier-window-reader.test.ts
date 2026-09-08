// The walk back past a window's head, driven end to end.
//
// Every case here drives the REAL reader over the REAL fixture bridge and the REAL
// session store: the request goes out through the console's one call door, the reply is
// parsed against the registered `timeline.read` schema on the way back, and the rows
// land in the store's own log through its own head door. A stubbed transport would
// have proved that this module can call a function.
//
// THE SCENARIO SCRIPTS THREE WINDOWS. The store opens on the newest one, and two
// presses reach the other two — the second of them terminal, so the walk retires
// itself rather than offering a press that answers nothing.

import { describe, expect, it } from "vitest";

import type { SessionId, TimelineReadRequest, TimelineRow } from "@ai-sidekicks/contracts";

import {
  createFixture,
  SCRIPTED_LATENCY_MS,
} from "../../../bridge/fixture/fixture-bridge.test-support.js";
import type { ConsoleScenario } from "../../../bridge/scenario-runtime/index.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { SessionStore } from "../../../store/index.js";
import { eventOfKind } from "../../../store/session-event.test-support.js";
import { LedgerEarlierWindowReader } from "./earlier-window-reader.js";

const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";

/** Where the store's window opens: the position its establishing read submitted. */
const WINDOW_HEAD_CURSOR = "cursor-at-40";

/** Where a later completed read re-opens it — the head a refresh moves the store to. */
const LATER_WINDOW_HEAD_CURSOR = "cursor-at-60";

function rowAt(sequence: number): TimelineRow {
  return {
    kind: "general",
    id: `event-${String(sequence)}`,
    sessionId: SESSION_ID as SessionId,
    sequence,
    category: "membership_change",
    type: "participant.joined",
    summary: `row ${String(sequence)}`,
    timestamp: "2026-01-01T11:00:00.000Z",
    payload: {},
  };
}

/**
 * The three windows, keyed by the position they are asked from.
 *
 * A computed reply rather than three scenarios, because the seam under test is that
 * the reader hands back the cursor the LAST page ended at: a table keyed on
 * `beforeCursor` refuses a walk that re-asks from the head, and a fixed reply would
 * answer the same page forever and pass either way.
 */
const PAGES_BY_BEFORE_CURSOR: Readonly<Record<string, unknown>> = {
  [WINDOW_HEAD_CURSOR]: {
    entries: [rowAt(35), rowAt(36), rowAt(37)],
    hasMore: true,
    nextCursor: "cursor-at-35",
  },
  "cursor-at-35": { entries: [rowAt(30), rowAt(31)], hasMore: false },
  [LATER_WINDOW_HEAD_CURSOR]: { entries: [rowAt(55), rowAt(56)], hasMore: false },
};

/** The window a request asks for, read off the position it named. */
function pageForRequest(request: unknown): unknown {
  const beforeCursor = (request as TimelineReadRequest | undefined)?.beforeCursor;
  return beforeCursor === undefined ? undefined : PAGES_BY_BEFORE_CURSOR[beforeCursor];
}

function pagingScenario(): ConsoleScenario {
  return {
    id: "ledger-backward-paging",
    label: "Backward paging",
    purpose: "Serves four windows of one session's log, keyed by the position asked from.",
    sessionId: SESSION_ID,
    participantIdsInJoinOrder: [],
    beats: [],
    replies: [{ call: "timeline.read", resultFor: pageForRequest }],
    startedAtIso: "2026-01-01T10:05:00.000Z",
  };
}

/**
 * The same script, answered a scripted latency later.
 *
 * A page is only in flight for as long as the transport takes, so a case about what
 * happens to the store WHILE one is outstanding needs a reply the caller releases:
 * the fixture holds this one until the engine is advanced past it, which is the one
 * way this console can script that window without a hand-built transport.
 */
function delayedPagingScenario(): ConsoleScenario {
  return {
    ...pagingScenario(),
    id: "ledger-backward-paging-held",
    replies: [{ call: "timeline.read", afterMs: SCRIPTED_LATENCY_MS, resultFor: pageForRequest }],
  };
}

function openStore(options: { readonly readFromCursor?: string } = {}): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({
    cursor: 41,
    entities: [],
    participantJoinLog: [],
    timeline: [40, 41].map((sequence) => eventOfKind(SESSION_ID, "run.started", sequence)),
    ...(options.readFromCursor === undefined ? {} : { readFromCursor: options.readFromCursor }),
  });
  return store;
}

function sequencesOf(store: SessionStore): readonly number[] {
  return store.snapshot().timeline.map((event) => event.sequence);
}

describe("LedgerEarlierWindowReader — three windows, two presses, and then nothing left", () => {
  it("walks back a page at a time and retires itself on the producer's verdict", async () => {
    const { bridge } = createFixture(pagingScenario());
    const store = openStore({ readFromCursor: WINDOW_HEAD_CURSOR });
    const reader = new LedgerEarlierWindowReader();

    expect(reader.state(store).canLoadEarlier).toBe(true);

    await reader.loadEarlier(bridge, store);
    expect(sequencesOf(store)).toStrictEqual([35, 36, 37, 40, 41]);
    expect(reader.state(store)).toMatchObject({
      canLoadEarlier: true,
      isReading: false,
      refusal: undefined,
      admittedRowCount: 3,
    });

    await reader.loadEarlier(bridge, store);
    expect(sequencesOf(store)).toStrictEqual([30, 31, 35, 36, 37, 40, 41]);
    expect(reader.state(store)).toMatchObject({ canLoadEarlier: false, admittedRowCount: 5 });

    // The third press. Nothing is asked for and nothing lands — the negative control
    // for a walk that read `hasMore` and then kept going anyway.
    await reader.loadEarlier(bridge, store);
    expect(sequencesOf(store)).toStrictEqual([30, 31, 35, 36, 37, 40, 41]);
  });

  it("offers nothing when the window opens at the beginning of the log", async () => {
    // A first read submits no position, so there is nothing before the window. The
    // control's absence is the ordinary case rather than a failure.
    const { bridge } = createFixture(pagingScenario());
    const store = openStore();
    const reader = new LedgerEarlierWindowReader();

    expect(reader.state(store).canLoadEarlier).toBe(false);

    await reader.loadEarlier(bridge, store);
    expect(sequencesOf(store)).toStrictEqual([40, 41]);
  });

  it("drops a second press while a page is in flight", async () => {
    const { bridge } = createFixture(pagingScenario());
    const store = openStore({ readFromCursor: WINDOW_HEAD_CURSOR });
    const reader = new LedgerEarlierWindowReader();

    // Both started before either settles. Without the single flight the second call
    // asks from the same cursor, and the page it brings back is refused row by row by
    // the store's own head guard — a round trip spent to add nothing.
    const first = reader.loadEarlier(bridge, store);
    const second = reader.loadEarlier(bridge, store);
    await Promise.all([first, second]);

    expect(sequencesOf(store)).toStrictEqual([35, 36, 37, 40, 41]);
    expect(reader.state(store).admittedRowCount).toBe(3);
  });

  it("carries the refusal a rejected read answered with, and offers the press again", async () => {
    // The scenario scripts a reply for the head cursor and none for this one, so the
    // fixture refuses it as unscripted — which is a real refusal travelling the real
    // path, not a fabricated one.
    const { bridge } = createFixture(pagingScenario());
    const store = openStore({ readFromCursor: "cursor-nobody-scripted" });
    const reader = new LedgerEarlierWindowReader();

    await reader.loadEarlier(bridge, store);
    const state = reader.state(store);

    expect(state.refusal?.code).toBeDefined();
    expect(state.canLoadEarlier).toBe(true);
    expect(sequencesOf(store)).toStrictEqual([40, 41]);
  });

  it("starts the walk over when a completed read re-establishes the window", async () => {
    const { bridge } = createFixture(pagingScenario());
    const store = openStore({ readFromCursor: WINDOW_HEAD_CURSOR });
    const reader = new LedgerEarlierWindowReader();
    await reader.loadEarlier(bridge, store);
    expect(reader.state(store).admittedRowCount).toBe(3);

    // The same head cursor, so a comparison of positions would notice nothing — what
    // does is the store's window generation, which a completed read re-takes whichever
    // position it answered at. The cursor is ahead of the store's, because a read
    // behind it is refused as stale and would leave the log, and this walk's place in
    // it, exactly as they were.
    store.initialise({
      cursor: 45,
      entities: [],
      participantJoinLog: [],
      timeline: [44, 45].map((sequence) => eventOfKind(SESSION_ID, "run.started", sequence)),
      readFromCursor: WINDOW_HEAD_CURSOR,
    });

    expect(reader.state(store).admittedRowCount).toBe(0);
    await reader.loadEarlier(bridge, store);
    expect(sequencesOf(store)).toStrictEqual([35, 36, 37, 44, 45]);
  });
});

/** The refresh a live session performs: a later completed read re-opens the window. */
function refreshWindowHigherUp(store: SessionStore): void {
  store.initialise({
    cursor: 61,
    entities: [],
    participantJoinLog: [],
    timeline: [60, 61].map((sequence) => eventOfKind(SESSION_ID, "run.started", sequence)),
    readFromCursor: LATER_WINDOW_HEAD_CURSOR,
  });
}

describe("LedgerEarlierWindowReader — a refresh lands while a page is in flight", () => {
  it("discards the page and fills the interval from the head the refresh established", async () => {
    const { bridge, engine } = createFixture(delayedPagingScenario());
    const store = openStore({ readFromCursor: WINDOW_HEAD_CURSOR });
    const reader = new LedgerEarlierWindowReader();

    const heldPage = reader.loadEarlier(bridge, store);
    await crossMacrotaskBoundary();
    expect(engine.pendingReplyCount).toBe(1);

    refreshWindowHigherUp(store);
    engine.advance(SCRIPTED_LATENCY_MS);
    await heldPage;

    // Rows 35-37 are earlier than a head this window never opened at. Merging them
    // would put them in front of row 60 and move the log's head sequence down to 35,
    // and every page after that — the ones that would have filled 38-59 — would be
    // refused by the store's own strictly-earlier guard. So the window holds exactly
    // what the refresh established.
    expect(sequencesOf(store)).toStrictEqual([60, 61]);
    expect(reader.state(store)).toMatchObject({
      canLoadEarlier: true,
      isReading: false,
      refusal: undefined,
      admittedRowCount: 0,
    });

    // And the interval is reachable: the next press asks from the head the store now
    // has, and the rows below it land.
    const nextPage = reader.loadEarlier(bridge, store);
    await crossMacrotaskBoundary();
    engine.advance(SCRIPTED_LATENCY_MS);
    await nextPage;

    expect(sequencesOf(store)).toStrictEqual([55, 56, 60, 61]);
    expect(reader.state(store).admittedRowCount).toBe(2);
  });

  it("lands the same held page when nothing moved the window under it", async () => {
    // The control for the case above: same scenario, same latency, same page — and
    // with no refresh in the middle it merges exactly as an undelayed one does, so
    // what the discard is caused by is the window moving and not the wait.
    const { bridge, engine } = createFixture(delayedPagingScenario());
    const store = openStore({ readFromCursor: WINDOW_HEAD_CURSOR });
    const reader = new LedgerEarlierWindowReader();

    const heldPage = reader.loadEarlier(bridge, store);
    await crossMacrotaskBoundary();
    engine.advance(SCRIPTED_LATENCY_MS);
    await heldPage;

    expect(sequencesOf(store)).toStrictEqual([35, 36, 37, 40, 41]);
    expect(reader.state(store).admittedRowCount).toBe(3);
  });
});
