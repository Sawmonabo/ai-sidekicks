// The walk back past a window's head, end to end: the real reader over the real session store,
// with the read as the one seam a test supplies. The scripted read answers three windows; the
// store opens on the newest and two presses reach the others, the second terminal so the walk
// retires.

import { describe, expect, it } from "vitest";

import {
  TranscriptReadResponseSchema,
  type TranscriptReadRequest,
  type TranscriptReadResponse,
} from "@ai-sidekicks/contracts/transcript/operations";
import type { EventCursor, SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { type DaemonReply } from "#renderer/services/daemon/reply.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { eventOfKind } from "#test/helpers/session/events.js";
import { EarlierHistoryReader, type EarlierPageRead } from "./earlier-reader.js";

const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";

/** Where the store's window opens: the position its establishing read submitted. */
const WINDOW_HEAD_CURSOR = "cursor-at-40";

/** Where a later completed read re-opens it — the head a refresh moves the store to. */
const LATER_WINDOW_HEAD_CURSOR = "cursor-at-60";

function rowAt(sequence: number): TranscriptEventRow {
  return {
    kind: "general",
    id: `event-${String(sequence)}`,
    sessionId: SESSION_ID as SessionId,
    sequence,
    cursor: `cursor-at-${String(sequence)}` as EventCursor,
    category: "session_lifecycle",
    type: "session.renamed",
    summary: `row ${String(sequence)}`,
    timestamp: "2026-01-01T11:00:00.000Z",
    payload: {},
  };
}

/**
 * The three windows, keyed by the position they are asked from. A computed reply, not a fixed
 * one: the reader must hand back the cursor the last page ended at, and a fixed reply would
 * answer the same page forever and pass either way.
 */
const PAGES_BY_BEFORE_CURSOR: Readonly<Record<string, TranscriptReadResponse>> = {
  [WINDOW_HEAD_CURSOR]: TranscriptReadResponseSchema.parse({
    entries: [rowAt(35), rowAt(36), rowAt(37)],
    hasMore: true,
    nextCursor: "cursor-at-35",
  }),
  "cursor-at-35": TranscriptReadResponseSchema.parse({
    entries: [rowAt(30), rowAt(31)],
    hasMore: false,
  }),
  [LATER_WINDOW_HEAD_CURSOR]: TranscriptReadResponseSchema.parse({
    entries: [rowAt(55), rowAt(56)],
    hasMore: false,
  }),
};

function replyFor(request: TranscriptReadRequest): DaemonReply<TranscriptReadResponse> {
  const page =
    request.beforeCursor === undefined ? undefined : PAGES_BY_BEFORE_CURSOR[request.beforeCursor];
  return page === undefined
    ? {
        status: "refused",
        refusal: { code: "unscripted", detail: "No page for that position.", origin: "test" },
      }
    : { status: "served", value: page };
}

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

/** A read whose replies wait until the test releases them, so a page can stay in flight. */
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
    transcript: [40, 41].map((sequence) => eventOfKind(SESSION_ID, "run.started", sequence)),
    ...(options.readFromCursor === undefined ? {} : { readFromCursor: options.readFromCursor }),
  });
  return store;
}

function sequencesOf(store: SessionStore): readonly number[] {
  return store.snapshot().transcript.map((event) => event.sequence);
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
    });

    await reader.loadEarlier(read, store);
    expect(sequencesOf(store)).toStrictEqual([30, 31, 35, 36, 37, 40, 41]);
    expect(reader.state(store).canLoadEarlier).toBe(false);

    // The third press: nothing is asked and nothing lands (guards a walk that read `hasMore`
    // and kept going).
    await reader.loadEarlier(read, store);
    expect(sequencesOf(store)).toStrictEqual([30, 31, 35, 36, 37, 40, 41]);
  });

  it("offers nothing when the window opens at the beginning of the log", async () => {
    // A first read submits no position, so nothing lies before the window; the control's
    // absence is the ordinary case.
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

    // Both start before either settles. Without single flight the second asks from the same
    // cursor and the store's head guard refuses the page row by row.
    const first = reader.loadEarlier(read, store);
    const second = reader.loadEarlier(read, store);
    await Promise.all([first, second]);

    expect(calls()).toBe(1);
    expect(sequencesOf(store)).toStrictEqual([35, 36, 37, 40, 41]);
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
    expect(sequencesOf(store)).toStrictEqual([35, 36, 37, 40, 41]);

    // The same head cursor, so comparing positions would notice nothing; the store's window
    // generation, re-taken by any completed read, does. A store holding a window takes a read
    // only as a repair.
    store.markReadFailed();
    store.initialize({
      cursor: 45,
      entities: [],
      transcript: [44, 45].map((sequence) => eventOfKind(SESSION_ID, "run.started", sequence)),
      readFromCursor: WINDOW_HEAD_CURSOR,
    });

    await reader.loadEarlier(read, store);
    expect(sequencesOf(store)).toStrictEqual([35, 36, 37, 44, 45]);
  });
});

/** A repair read landing on the store, its window opened higher up the log. */
function refreshWindowHigherUp(store: SessionStore): void {
  store.markReadFailed();
  store.initialize({
    cursor: 61,
    entities: [],
    transcript: [60, 61].map((sequence) => eventOfKind(SESSION_ID, "run.started", sequence)),
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

    // Rows 35-37 are earlier than a head this window never opened at. Merging them would move
    // the log's head down and the store's strictly-earlier guard would refuse every later page
    // (38-59). So the window holds exactly what the refresh established.
    expect(sequencesOf(store)).toStrictEqual([60, 61]);
    expect(reader.state(store)).toMatchObject({
      canLoadEarlier: true,
      isReading: false,
      refusal: undefined,
    });

    // And the interval is reachable: the next press asks from the head the store now has.
    const nextPage = reader.loadEarlier(held.read, store);
    held.releaseAll();
    await nextPage;

    expect(sequencesOf(store)).toStrictEqual([55, 56, 60, 61]);
  });

  it("lands the same held page when nothing moved the window under it", async () => {
    // Control: the same read, hold and page with no refresh in the middle merges as an
    // undelayed one does, so the discard is caused by the window moving, not the wait.
    const held = heldRead();
    const store = openStore({ readFromCursor: WINDOW_HEAD_CURSOR });
    const reader = new EarlierHistoryReader();

    const heldPage = reader.loadEarlier(held.read, store);
    held.releaseAll();
    await heldPage;

    expect(sequencesOf(store)).toStrictEqual([35, 36, 37, 40, 41]);
  });
});

describe("EarlierHistoryReader — the pane leaves while a page is in flight", () => {
  it("stops the read and installs neither the page nor a refusal", async () => {
    // The page must not land, and neither must `callDaemon`'s `read-abandoned` refusal: a pane
    // that left is not a failure. Control: the case above merges the same page while the line
    // is still live.
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
    });
  });
});
