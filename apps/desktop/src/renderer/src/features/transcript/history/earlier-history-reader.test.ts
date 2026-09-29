// The walk back past a window's head, driven end to end.
//
// Every case here drives the REAL reader over the REAL session store: the rows land in
// the store's own log through `prependEarlierEvents`, the one call that grows it at its
// head. The read is the one seam a test
// supplies, because the walk takes it from whichever composition has one.
//
// THE READ ANSWERS THREE WINDOWS. The store opens on the newest one, and two
// presses reach the other two — the second of them terminal, so the walk retires
// itself rather than offering a press that answers nothing.

import { describe, expect, it } from "vitest";

import {
  TimelineReadResponseSchema,
  type SessionId,
  type TimelineReadRequest,
  type TimelineReadResponse,
  type TimelineRow,
} from "@ai-sidekicks/contracts";

import { type DaemonReply } from "@renderer/services/daemon/daemon-reply.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { EarlierHistoryReader, type EarlierPageRead } from "./earlier-history-reader.js";

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
    category: "session_lifecycle",
    type: "session.renamed",
    summary: `row ${String(sequence)}`,
    timestamp: "2026-01-01T11:00:00.000Z",
    payload: {},
  };
}

/**
 * The three windows, keyed by the position they are asked from.
 *
 * A computed reply rather than a fixed one, because the seam under test is that the
 * reader hands back the cursor the LAST page ended at: a table keyed on `beforeCursor`
 * refuses a walk that re-asks from the head, and a fixed reply would answer the same
 * page forever and pass either way.
 */
const PAGES_BY_BEFORE_CURSOR: Readonly<Record<string, TimelineReadResponse>> = {
  [WINDOW_HEAD_CURSOR]: TimelineReadResponseSchema.parse({
    entries: [rowAt(35), rowAt(36), rowAt(37)],
    hasMore: true,
    nextCursor: "cursor-at-35",
  }),
  "cursor-at-35": TimelineReadResponseSchema.parse({
    entries: [rowAt(30), rowAt(31)],
    hasMore: false,
  }),
  [LATER_WINDOW_HEAD_CURSOR]: TimelineReadResponseSchema.parse({
    entries: [rowAt(55), rowAt(56)],
    hasMore: false,
  }),
};

/** The window a request asks for, or a refusal for a position nobody scripted. */
function replyFor(request: TimelineReadRequest): DaemonReply<TimelineReadResponse> {
  const page =
    request.beforeCursor === undefined ? undefined : PAGES_BY_BEFORE_CURSOR[request.beforeCursor];
  return page === undefined
    ? {
        status: "refused",
        refusal: { code: "unscripted", detail: "No page for that position.", origin: "test" },
      }
    : { status: "served", value: page };
}

/** A read that answers at once, and counts how often it was asked. */
function immediateRead(): { readonly read: EarlierPageRead; readonly calls: () => number } {
  let calls = 0;
  return {
    read: (request) => {
      calls += 1;
      return Promise.resolve(replyFor(request));
    },
    calls: () => calls,
  };
}

/**
 * A read whose replies wait until the test releases them.
 *
 * A page is only in flight for as long as the transport takes, so a case about what
 * happens to the store WHILE one is outstanding needs a reply the caller releases.
 */
function heldRead(): {
  readonly read: EarlierPageRead;
  readonly pendingCount: () => number;
  readonly releaseAll: () => void;
} {
  const pending: (() => void)[] = [];
  return {
    read: (request) =>
      new Promise((resolve) => {
        pending.push(() => {
          resolve(replyFor(request));
        });
      }),
    pendingCount: () => pending.length,
    releaseAll: () => {
      for (const release of pending.splice(0)) {
        release();
      }
    },
  };
}

function openStore(options: { readonly readFromCursor?: string } = {}): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialize({
    cursor: 41,
    entities: [],
    timeline: [40, 41].map((sequence) => eventOfKind(SESSION_ID, "run.started", sequence)),
    ...(options.readFromCursor === undefined ? {} : { readFromCursor: options.readFromCursor }),
  });
  return store;
}

function sequencesOf(store: SessionStore): readonly number[] {
  return store.snapshot().timeline.map((event) => event.sequence);
}

describe("EarlierHistoryReader — three windows, two presses, and then nothing left", () => {
  it("walks back a page at a time and retires itself on the producer's verdict", async () => {
    const { read } = immediateRead();
    const store = openStore({ readFromCursor: WINDOW_HEAD_CURSOR });
    const reader = new EarlierHistoryReader();

    expect(reader.state(store).canLoadEarlier).toBe(true);

    await reader.loadEarlier(read, store);
    expect(sequencesOf(store)).toStrictEqual([35, 36, 37, 40, 41]);
    expect(reader.state(store)).toMatchObject({
      canLoadEarlier: true,
      isReading: false,
      refusal: undefined,
      admittedRowCount: 3,
    });

    await reader.loadEarlier(read, store);
    expect(sequencesOf(store)).toStrictEqual([30, 31, 35, 36, 37, 40, 41]);
    expect(reader.state(store)).toMatchObject({ canLoadEarlier: false, admittedRowCount: 5 });

    // The third press. Nothing is asked for and nothing lands — the negative control
    // for a walk that read `hasMore` and then kept going anyway.
    await reader.loadEarlier(read, store);
    expect(sequencesOf(store)).toStrictEqual([30, 31, 35, 36, 37, 40, 41]);
  });

  it("offers nothing when the window opens at the beginning of the log", async () => {
    // A first read submits no position, so there is nothing before the window. The
    // control's absence is the ordinary case rather than a failure.
    const { read } = immediateRead();
    const store = openStore();
    const reader = new EarlierHistoryReader();

    expect(reader.state(store).canLoadEarlier).toBe(false);

    await reader.loadEarlier(read, store);
    expect(sequencesOf(store)).toStrictEqual([40, 41]);
  });

  it("drops a second press while a page is in flight", async () => {
    const { read, calls } = immediateRead();
    const store = openStore({ readFromCursor: WINDOW_HEAD_CURSOR });
    const reader = new EarlierHistoryReader();

    // Both started before either settles. Without the single flight the second call
    // asks from the same cursor, and the page it brings back is refused row by row by
    // the store's own head guard — a round trip spent to add nothing.
    const first = reader.loadEarlier(read, store);
    const second = reader.loadEarlier(read, store);
    await Promise.all([first, second]);

    expect(calls()).toBe(1);
    expect(sequencesOf(store)).toStrictEqual([35, 36, 37, 40, 41]);
    expect(reader.state(store).admittedRowCount).toBe(3);
  });

  it("carries the refusal a rejected read answered with, and offers the press again", async () => {
    // The read answers the scripted positions and refuses this one.
    const { read } = immediateRead();
    const store = openStore({ readFromCursor: "cursor-nobody-scripted" });
    const reader = new EarlierHistoryReader();

    await reader.loadEarlier(read, store);
    const state = reader.state(store);

    expect(state.refusal?.code).toBe("unscripted");
    expect(state.canLoadEarlier).toBe(true);
    expect(sequencesOf(store)).toStrictEqual([40, 41]);
  });

  it("starts the walk over when a completed read re-establishes the window", async () => {
    const { read } = immediateRead();
    const store = openStore({ readFromCursor: WINDOW_HEAD_CURSOR });
    const reader = new EarlierHistoryReader();
    await reader.loadEarlier(read, store);
    expect(reader.state(store).admittedRowCount).toBe(3);

    // The same head cursor, so a comparison of positions would notice nothing — what
    // does is the store's window generation, which a completed read re-takes whichever
    // position it answered at. The cursor is ahead of the store's, because a read
    // behind it is refused as stale and would leave the log, and this walk's place in
    // it, exactly as they were.
    store.initialize({
      cursor: 45,
      entities: [],
      timeline: [44, 45].map((sequence) => eventOfKind(SESSION_ID, "run.started", sequence)),
      readFromCursor: WINDOW_HEAD_CURSOR,
    });

    expect(reader.state(store).admittedRowCount).toBe(0);
    await reader.loadEarlier(read, store);
    expect(sequencesOf(store)).toStrictEqual([35, 36, 37, 44, 45]);
  });
});

/** The refresh a live session performs: a later completed read re-opens the window. */
function refreshWindowHigherUp(store: SessionStore): void {
  store.initialize({
    cursor: 61,
    entities: [],
    timeline: [60, 61].map((sequence) => eventOfKind(SESSION_ID, "run.started", sequence)),
    readFromCursor: LATER_WINDOW_HEAD_CURSOR,
  });
}

describe("EarlierHistoryReader — a refresh lands while a page is in flight", () => {
  it("discards the page and fills the interval from the head the refresh established", async () => {
    const held = heldRead();
    const store = openStore({ readFromCursor: WINDOW_HEAD_CURSOR });
    const reader = new EarlierHistoryReader();

    const heldPage = reader.loadEarlier(held.read, store);
    expect(held.pendingCount()).toBe(1);

    refreshWindowHigherUp(store);
    held.releaseAll();
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
    const nextPage = reader.loadEarlier(held.read, store);
    held.releaseAll();
    await nextPage;

    expect(sequencesOf(store)).toStrictEqual([55, 56, 60, 61]);
    expect(reader.state(store).admittedRowCount).toBe(2);
  });

  it("lands the same held page when nothing moved the window under it", async () => {
    // The control for the case above: same read, same hold, same page — and
    // with no refresh in the middle it merges exactly as an undelayed one does, so
    // what the discard is caused by is the window moving and not the wait.
    const held = heldRead();
    const store = openStore({ readFromCursor: WINDOW_HEAD_CURSOR });
    const reader = new EarlierHistoryReader();

    const heldPage = reader.loadEarlier(held.read, store);
    held.releaseAll();
    await heldPage;

    expect(sequencesOf(store)).toStrictEqual([35, 36, 37, 40, 41]);
    expect(reader.state(store).admittedRowCount).toBe(3);
  });
});

describe("EarlierHistoryReader — the pane leaves while a page is in flight", () => {
  it("stops the read and installs neither the page nor a refusal", async () => {
    // WHAT THE ABANDONMENT HAS TO BUY, stated as both halves. The page must not land —
    // it belongs to a walk nobody is offering a control for — and `callDaemon`'s own
    // `read-abandoned` refusal must not land either, because a pane that left is
    // not a failure to report. The control is the case directly above: the same
    // read, the same hold, and the same page merges when the line is still
    // anybody's, so what stops it here is the abandonment and not the wait.
    const held = heldRead();
    const store = openStore({ readFromCursor: WINDOW_HEAD_CURSOR });
    const reader = new EarlierHistoryReader();

    const heldPage = reader.loadEarlier(held.read, store);
    expect(held.pendingCount()).toBe(1);

    reader.abandonReads();
    held.releaseAll();
    await heldPage;

    expect(reader.isAbandoned).toBe(true);
    expect(sequencesOf(store)).toStrictEqual([40, 41]);
    expect(reader.state(store)).toMatchObject({
      isReading: false,
      refusal: undefined,
      admittedRowCount: 0,
    });
  });
});
