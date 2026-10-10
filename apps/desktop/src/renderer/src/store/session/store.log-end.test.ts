// The store's way to put a page read at an end of the log in place of its whole window,
// `replaceWithLogEndPage`: Home's first page closes the head, and End's newest page goes live only
// when it reaches what the stream has delivered, so no row the stream sent is skipped or doubled.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { describe, expect, it } from "vitest";

import { SessionStore } from "./store.js";
import { eventOfKind } from "#test/helpers/session/events.js";

const SESSION_ID = "session-log-end-store";

/** The sequence the stream has delivered up to. */
const STREAM_SEQUENCE = 40;

function eventsAt(sequences: readonly number[]): ReturnType<typeof eventOfKind>[] {
  return sequences.map((sequence) => eventOfKind(SESSION_ID, "run.running", sequence));
}

/** A store reading the middle of a long log: rows 20 to 22 held, both edges with more past them. */
function storeInTheMiddle(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialize({
    cursor: STREAM_SEQUENCE,
    entities: [],
    transcript: eventsAt([20, 21, 22, 23]),
    transcriptHead: { cursor: "cursor-at-19" as EventCursor, hasMore: true },
  });
  store.releaseOutside("cursor-at-20" as EventCursor, "cursor-at-22" as EventCursor);
  return store;
}

function heldSequences(store: SessionStore): number[] {
  return store.snapshot().transcript.map((event) => event.sequence);
}

describe("SessionStore.replaceWithLogEndPage — an end page replaces the window", () => {
  it("closes the head on the log's first page and leaves the tail detached after it", () => {
    const store = storeInTheMiddle();
    store.replaceWithLogEndPage("start", eventsAt([0, 1, 2]), {
      cursor: "cursor-at-2" as EventCursor,
      hasMore: true,
    });

    expect(heldSequences(store)).toStrictEqual([0, 1, 2]);
    expect(store.snapshot().transcriptHead).toStrictEqual({ cursor: undefined, hasMore: false });
    expect(store.snapshot().transcriptTail).toStrictEqual({
      cursor: "cursor-at-2",
      hasMore: true,
      following: "detached",
    });
  });

  it("goes live on the newest page only once it reaches what the stream delivered", () => {
    const pageEdge = { cursor: "cursor-at-37" as EventCursor, hasMore: true };
    const reaching = storeInTheMiddle();
    reaching.replaceWithLogEndPage("end", eventsAt([38, 39, STREAM_SEQUENCE]), pageEdge);

    expect(heldSequences(reaching)).toStrictEqual([38, 39, STREAM_SEQUENCE]);
    expect(reaching.snapshot().transcriptHead).toBe(pageEdge);
    expect(reaching.snapshot().transcriptTail.following).toBe("live");

    // The stream delivered past the page while it was read: the tail waits detached after it.
    const behind = storeInTheMiddle();
    behind.replaceWithLogEndPage("end", eventsAt([37, 38, 39]), pageEdge);
    expect(behind.snapshot().transcriptTail).toStrictEqual({
      cursor: "cursor-at-39",
      hasMore: true,
      following: "detached",
    });
  });

  it("moves nothing on a page of another session's rows", () => {
    const store = storeInTheMiddle();
    store.replaceWithLogEndPage("start", [eventOfKind("some-other-session", "run.running", 0)], {
      cursor: undefined,
      hasMore: false,
    });

    expect(heldSequences(store)).toStrictEqual([20, 21, 22]);
  });
});
