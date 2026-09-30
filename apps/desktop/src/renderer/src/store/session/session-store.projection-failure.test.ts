// A registered projector throws on an event. The failure is the caller's, but the chokepoint owes
// containment: the event costs its entity contribution and nothing else, a mutation set applies
// all or not at all, and the loss is named, since only a re-pull can supply the missing
// mutation. Other modes are in the sibling `session-store.*.test.ts` suites.

import { describe, expect, it } from "vitest";

import { eventAt } from "./session-store.test-support.js";
import { SessionStore } from "./session-store.js";

describe("failure matrix — a registered projector throws on an event", () => {
  const REJECTED_SEQUENCE = 3;

  function storeWithProjectorThrowingAt(sequence: number): SessionStore {
    return new SessionStore({
      sessionId: "session-1",
      projectors: {
        "run.starting": (event) => {
          if (event.sequence === sequence) {
            throw new TypeError("the payload was not the shape this projector claims");
          }
          return [
            {
              operation: "upsert",
              entity: { kind: "run", id: `run-${String(event.sequence)}` },
            },
          ];
        },
      },
    });
  }

  it("costs the event its entity contribution, never the batch and never the process", () => {
    const store = storeWithProjectorThrowingAt(REJECTED_SEQUENCE);
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([1, 2, 3, 4, 5].map((sequence) => eventAt(sequence)));

    expect(outcome.projectionFailures).toBe(1);
    expect(outcome.admitted).toBe(5);
    // The batch survives whole and the loss is named, not absorbed.
    expect(store.snapshot().timeline.map((event) => event.sequence)).toStrictEqual([1, 2, 3, 4, 5]);
    expect(Object.keys(store.snapshot().partitions.run).sort()).toStrictEqual([
      "run-1",
      "run-2",
      "run-4",
      "run-5",
    ]);
    expect(store.snapshot().degradedCause).toBe("projection-failed");
  });

  it("applies a failing event's mutations all or not at all", () => {
    // A good mutation then a malformed one: merging the first would leave half a transition.
    const store = new SessionStore({
      sessionId: "session-1",
      projectors: {
        "run.starting": () => [
          { operation: "upsert", entity: { kind: "run", id: "run-half-applied" } },
          {
            operation: "upsert",
            entity: { kind: "not-a-kind" as never, id: "run-unmergeable" },
          },
        ],
      },
    });
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([eventAt(1)]);

    expect(outcome.projectionFailures).toBe(1);
    expect(store.snapshot().partitions.run).toStrictEqual({});
    expect(store.snapshot().degradedCause).toBe("projection-failed");
  });

  it("negative control: a projector that returns cleanly still projects and leaves no cause", () => {
    const store = storeWithProjectorThrowingAt(Number.NaN);
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([eventAt(1), eventAt(2)]);

    expect(outcome.projectionFailures).toBe(0);
    expect(Object.keys(store.snapshot().partitions.run).sort()).toStrictEqual(["run-1", "run-2"]);
    expect(store.snapshot().degradedCause).toBeUndefined();
  });
});
