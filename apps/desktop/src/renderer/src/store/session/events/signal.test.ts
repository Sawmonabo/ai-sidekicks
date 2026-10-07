// The event-kind signal across a repair: the row a repair lands in a hole sits below the cursor
// already seen, and is still counted once, as a row a watched read would otherwise miss.

import { describe, expect, it } from "vitest";

import { eventOfKind } from "#test/helpers/session/events.js";
import { SessionStore } from "../store.js";
import { subscribeToSessionEventKinds } from "./signal.js";

const SESSION_ID = "session-signal";

function runRowAt(sequence: number): ReturnType<typeof eventOfKind> {
  return eventOfKind(SESSION_ID, "run.starting", sequence);
}

function watchedRowAt(sequence: number): ReturnType<typeof eventOfKind> {
  return eventOfKind(SESSION_ID, "workspace.ready", sequence);
}

describe("subscribeToSessionEventKinds", () => {
  it.each([
    {
      repair: "a replay that passes the rows held",
      landHole: (store: SessionStore): void => {
        store.initialize({ entities: [] });
        store.applyBatch([runRowAt(6), watchedRowAt(7), runRowAt(8)]);
      },
    },
    {
      repair: "a base read already past them",
      landHole: (store: SessionStore): void => {
        store.initialize({
          cursor: 8,
          entities: [],
          transcript: [runRowAt(6), watchedRowAt(7), runRowAt(8)],
        });
      },
    },
  ])("counts a watched row $repair lands below the cursor already seen, once", ({ landHole }) => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({ cursor: 5, entities: [] });
    let signals = 0;
    const unsubscribe = subscribeToSessionEventKinds(store, ["workspace.ready"], () => {
      signals += 1;
    });
    store.applyBatch([runRowAt(6), runRowAt(8)]);
    expect(store.snapshot().degradedCause).toBe("sequence-gap");

    landHole(store);
    expect(store.snapshot().degradedCause).toBeUndefined();
    store.applyBatch([runRowAt(9)]);
    unsubscribe();

    expect(signals).toBe(1);
  });

  it("counts a hole's watched row at the swap when a cause raised mid-replay outlives it", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({ cursor: 5, entities: [] });
    let signals = 0;
    const unsubscribe = subscribeToSessionEventKinds(store, ["workspace.ready"], () => {
      signals += 1;
    });
    store.applyBatch([runRowAt(6), runRowAt(8)]);

    store.initialize({ entities: [] });
    store.applyBatch([runRowAt(6)]);
    store.markDegraded("subscription-closed");
    store.applyBatch([watchedRowAt(7), runRowAt(8)]);
    expect(store.snapshot()).toMatchObject({
      isReplaying: false,
      degradedCause: "subscription-closed",
    });
    expect(signals).toBe(1);

    // The next repair replays the same rows, which the window already holds.
    store.initialize({ entities: [] });
    store.applyBatch([runRowAt(6), watchedRowAt(7), runRowAt(8)]);
    unsubscribe();

    expect(store.snapshot().degradedCause).toBeUndefined();
    expect(signals).toBe(1);
  });
});
