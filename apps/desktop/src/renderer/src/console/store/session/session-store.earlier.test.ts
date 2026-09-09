// The store's third door: a log growing at its head, and which end a cap then cuts.
//
// The two are one subject. A backward page is only worth reading if the cap keeps it,
// and the retained end is the whole of that guarantee — so every case below asserts
// the merge and the retention together rather than one of them over a store with no
// cap at all.

import { describe, expect, it } from "vitest";

import { SessionStore } from "./session-store.js";
import { eventOfKind } from "../session-event.test-support.js";

const SESSION_ID = "session-earlier-store";

function eventsAt(sequences: readonly number[]): ReturnType<typeof eventOfKind>[] {
  return sequences.map((sequence) => eventOfKind(SESSION_ID, "run.started", sequence));
}

function openStore(options: { readonly timelineCap?: number } = {}): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID, ...options });
  store.initialise({
    cursor: 20,
    entities: [],
    participantJoinLog: [],
    timeline: eventsAt([18, 19, 20]),
    readFromCursor: "cursor-at-18",
  });
  return store;
}

describe("SessionStore.prependEarlierEvents — the head door", () => {
  it("carries the submitted read position onto the window head", () => {
    expect(openStore().snapshot().windowHeadCursor).toBe("cursor-at-18");
  });

  it("reports no window head for a read that submitted no position", () => {
    // The ordinary first read. `undefined` is the honest "there is nothing before this
    // window", and it is what keeps the head control off a log that starts at its own
    // beginning.
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialise({ cursor: 3, entities: [], participantJoinLog: [], timeline: eventsAt([3]) });

    expect(store.snapshot().windowHeadCursor).toBeUndefined();
  });

  it("grows the log at the head and counts what it admitted", () => {
    const store = openStore();
    const merge = store.prependEarlierEvents(eventsAt([15, 16, 17]));

    expect(merge.admitted).toBe(3);
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([
      15, 16, 17, 18, 19, 20,
    ]);
  });

  it("refuses an event belonging to another session", () => {
    const store = openStore();
    const merge = store.prependEarlierEvents([eventOfKind("some-other-session", "run.started", 5)]);

    expect(merge.admitted).toBe(0);
    expect(store.snapshot().timeline).toHaveLength(3);
  });

  it("does not move the cursor, the gaps, or the degraded cause", () => {
    // A backward page is history, not progress: it says nothing about what the
    // subscription has reached and repairs nothing the reconciler recorded.
    const store = openStore();
    store.markDegraded("read-failed");
    store.prependEarlierEvents(eventsAt([17]));
    const state = store.snapshot();

    expect(state.cursor).toBe(20);
    expect(state.gaps).toStrictEqual([]);
    expect(state.degradedCause).toBe("read-failed");
  });

  it("keeps the OLDEST end once a backward page has landed", () => {
    // The negative control for the retained end. Under the ordinary newest-first cap
    // the four rows would be [17, 18, 19, 20] — the page is fetched and dropped in one
    // act, every press answers with nothing, and the walk can never advance.
    const store = openStore({ timelineCap: 4 });
    store.prependEarlierEvents(eventsAt([14, 15, 16, 17]));

    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([
      14, 15, 16, 17,
    ]);
  });

  it("keeps the NEWEST end while no backward page has landed", () => {
    const store = openStore({ timelineCap: 2 });
    store.applyBatch(eventsAt([21]));

    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([20, 21]);
  });

  it("releases the retained end when a completed read re-establishes the window", () => {
    const store = openStore({ timelineCap: 2 });
    // The page that puts the store on the oldest end, asserted through the merge it
    // answers with: the retained end is a private reading, and what a caller can see
    // of it is which rows survive the cap.
    expect(store.prependEarlierEvents(eventsAt([17])).admitted).toBe(1);

    store.initialise({
      cursor: 30,
      entities: [],
      participantJoinLog: [],
      timeline: eventsAt([29, 30]),
    });
    store.applyBatch(eventsAt([31]));

    // The newest end again — which IS the release, stated as the only thing the cap
    // lets an outside caller observe about it.
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([30, 31]);
  });
});
