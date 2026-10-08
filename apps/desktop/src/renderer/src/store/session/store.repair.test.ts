// A read landing on a store that already holds a window: a degraded store takes it whole, a whole
// store refuses it, and the counts a failure is said again by survive it.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { describe, expect, it } from "vitest";

import { eventOfKind } from "#test/helpers/session/events.js";
import type { EntityProjectorTable, ProjectedSessionEvent } from "./entities/vocabulary.js";
import type { SessionStoreState } from "./state.js";
import { SessionStore } from "./store.js";

const SESSION_ID = "session-1";

function eventAt(sequence: number): ProjectedSessionEvent {
  return eventOfKind(SESSION_ID, "run.starting", sequence);
}

function eventsAt(sequences: readonly number[]): ProjectedSessionEvent[] {
  return sequences.map(eventAt);
}

function sequencesOf(state: SessionStoreState): number[] {
  return state.transcript.map((event) => event.sequence);
}

/** One run per `run.starting` row, named for its sequence; the row at `failingSequence` throws. */
function runPerRow(failingSequence?: number): EntityProjectorTable {
  return {
    "run.starting": (event) => {
      if (event.sequence === failingSequence) {
        throw new TypeError("the payload was not the shape this projector claims");
      }
      return [
        { operation: "upsert", entity: { kind: "run", id: `run-${String(event.sequence)}` } },
      ];
    },
  };
}

describe("a read lands on a store that already holds a base state", () => {
  it("leaves a WHOLE store untouched by any base state, whatever it names", () => {
    // Guards against admitting every read, which would rebuild the projection on each focus
    // refresh and empty the transcript for a base state carrying none.
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });
    store.apply(eventAt(1));
    const before = store.snapshot();

    expect(store.initialize({ entities: [] })).toBe(false);
    expect(store.initialize({ cursor: 9, entities: [] })).toBe(false);

    expect(store.snapshot()).toBe(before);
    expect(store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([1]);
  });

  it("marks a healthy store degraded with the cause it is handed", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    store.markDegraded("subscription-closed");

    expect(store.snapshot().degradedCause).toBe("subscription-closed");
  });
});

describe("what a window keeps across its repair", () => {
  const WINDOW_HEAD = eventAt(10).cursor as EventCursor;

  it("moves the walk to a new window when a read replaces a degraded one", () => {
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({
      entities: [],
      streamAfterCursor: WINDOW_HEAD,
      transcriptHead: { cursor: WINDOW_HEAD, hasMore: true },
    });
    store.applyBatch(eventsAt([11, 12, 14]));
    store.prependEarlierEvents(eventsAt([8, 9]), {
      cursor: eventAt(7).cursor as EventCursor,
      hasMore: true,
    });
    const generation = store.windowGeneration;

    // A read that carried no rows opens the stream at the log's start.
    store.initialize({ entities: [] });
    store.applyBatch(eventsAt([8, 9, 10, 11, 12, 13, 14]));

    expect(sequencesOf(store.snapshot())).toStrictEqual([8, 9, 10, 11, 12, 13, 14]);
    expect(store.snapshot().transcriptHead).toStrictEqual({ cursor: undefined, hasMore: false });
    expect(store.windowGeneration).not.toBe(generation);
  });
});

describe("the counts a failure is said again by", () => {
  it("counts a cause the stream raises again once as it comes to stand", () => {
    const store = new SessionStore({ sessionId: SESSION_ID, projectors: runPerRow(3) });
    store.initialize({ entities: [] });
    store.applyBatch(eventsAt([1, 2, 3, 4]));
    expect(store.snapshot().raisedAgainCauseCount).toBe(1);
    // A cause already standing is not raised again.
    store.markDegraded("projection-failed");
    store.applyBatch(eventsAt([5]));
    expect(store.snapshot().raisedAgainCauseCount).toBe(1);
  });
});
