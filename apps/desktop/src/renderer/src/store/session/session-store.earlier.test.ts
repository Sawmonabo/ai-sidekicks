// The store's third way in, `prependEarlierEvents`: a log growing at its head, and which end a
// cap then cuts. A backward page is only worth reading if the cap keeps it, so each case asserts
// the merge and the retention together.

import { describe, expect, it } from "vitest";

import { SessionStore } from "./session-store.js";
import { eventOfKind } from "@test/helpers/session/events.js";

const SESSION_ID = "session-earlier-store";

function eventsAt(sequences: readonly number[]): ReturnType<typeof eventOfKind>[] {
  return sequences.map((sequence) => eventOfKind(SESSION_ID, "run.running", sequence));
}

function openStore(options: { readonly transcriptCap?: number } = {}): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID, ...options });
  store.initialize({
    cursor: 20,
    entities: [],
    transcript: eventsAt([18, 19, 20]),
    readFromCursor: "cursor-at-18",
  });
  return store;
}

describe("SessionStore.prependEarlierEvents — growing the log at its head", () => {
  it("grows the log at the head and counts what it admitted", () => {
    const store = openStore();
    const merge = store.prependEarlierEvents(eventsAt([15, 16, 17]));

    expect(merge.admitted).toBe(3);
    expect(store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([
      15, 16, 17, 18, 19, 20,
    ]);
  });

  it("refuses an event belonging to another session", () => {
    const store = openStore();
    const merge = store.prependEarlierEvents([eventOfKind("some-other-session", "run.running", 5)]);

    expect(merge.admitted).toBe(0);
    expect(store.snapshot().transcript).toHaveLength(3);
  });

  it("keeps the OLDEST end once a backward page has landed", () => {
    // Negative control: under the newest-first cap the page would be dropped as it landed,
    // every press would answer with nothing and the walk could never advance.
    const store = openStore({ transcriptCap: 4 });
    store.prependEarlierEvents(eventsAt([14, 15, 16, 17]));

    expect(store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([
      14, 15, 16, 17,
    ]);
  });

  it("keeps the NEWEST end while no backward page has landed", () => {
    const store = openStore({ transcriptCap: 2 });
    store.applyBatch(eventsAt([21]));

    expect(store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([20, 21]);
  });

  it("releases the retained end when a completed read re-establishes the window", () => {
    const store = openStore({ transcriptCap: 2 });
    // The retained end is private; a caller sees only which rows survive the cap.
    expect(store.prependEarlierEvents(eventsAt([17])).admitted).toBe(1);

    store.initialize({
      cursor: 30,
      entities: [],
      transcript: eventsAt([29, 30]),
    });
    store.applyBatch(eventsAt([31]));

    // The newest end again is the release.
    expect(store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([30, 31]);
  });
});
