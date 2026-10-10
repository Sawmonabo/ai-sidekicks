// The store's way to grow its window at the head, `prependEarlierEvents`: the page's rows land in
// front of the window and the head takes the page's own edge.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { describe, expect, it } from "vitest";

import { SessionStore } from "./store.js";
import type { TranscriptWindowEdge } from "./state.js";
import { eventOfKind } from "#test/helpers/session/events.js";

const SESSION_ID = "session-earlier-store";

/** The edge of a backward page whose oldest row sits at 15. */
const EARLIER_EDGE: TranscriptWindowEdge = {
  cursor: "cursor-at-14" as EventCursor,
  hasMore: true,
};

function eventsAt(sequences: readonly number[]): ReturnType<typeof eventOfKind>[] {
  return sequences.map((sequence) => eventOfKind(SESSION_ID, "run.running", sequence));
}

function openStore(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialize({
    cursor: 20,
    entities: [],
    transcript: eventsAt([18, 19, 20]),
    transcriptHead: { cursor: "cursor-at-17" as EventCursor, hasMore: true },
  });
  return store;
}

describe("SessionStore.prependEarlierEvents — growing the log at its head", () => {
  it("grows the log at the head and counts what it admitted", () => {
    const store = openStore();
    const merge = store.prependEarlierEvents({
      events: eventsAt([15, 16, 17]),
      edge: EARLIER_EDGE,
      runs: [],
    });

    expect(merge.admitted).toBe(3);
    expect(store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([
      15, 16, 17, 18, 19, 20,
    ]);
    expect(store.snapshot().transcriptHead).toBe(EARLIER_EDGE);
  });

  it("refuses an event belonging to another session", () => {
    const store = openStore();
    const merge = store.prependEarlierEvents({
      events: [eventOfKind("some-other-session", "run.running", 5)],
      edge: EARLIER_EDGE,
      runs: [],
    });

    expect(merge.admitted).toBe(0);
    expect(store.snapshot().transcript).toHaveLength(3);
  });
});
