// The event-kind signal across a repair: the rows a hole lost need not be rows the repaired
// window holds, so a repair signals once whatever its window carries, and is counted once.

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
      repair: "a replay landing the lost watched row",
      landHole: (store: SessionStore): void => {
        store.repair({ entities: [] }, { from: "head", headCursor: undefined });
        store.applyBatch([runRowAt(6), watchedRowAt(7), runRowAt(8)]);
      },
    },
    {
      repair: "a snapshot whose window holds none of the rows the hole lost",
      landHole: (store: SessionStore): void => {
        store.initialize({
          cursor: 20,
          entities: [],
          transcript: [runRowAt(19), runRowAt(20)],
        });
      },
    },
  ])("signals once on $repair, and not again for what follows", ({ landHole }) => {
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
    store.applyBatch([runRowAt(21)]);
    unsubscribe();

    expect(signals).toBe(1);
  });
});
