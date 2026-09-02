// A registered projector throws on an event.
//
// The failure is a caller's, not the store's: a projector handed a payload it did
// not expect. What the chokepoint owes is containment — the event costs its entity
// contribution and nothing else, a half-applied mutation set is applied all or not
// at all, and the loss is NAMED, because only a re-pull can supply the mutation
// that did not run.
//
// The sibling suites of `failure-modes.test.ts` cover the other modes.

import { describe, expect, it } from "vitest";

import { eventAt } from "./failure-modes.test-support.js";
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
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([1, 2, 3, 4, 5].map((sequence) => eventAt(sequence)));

    expect(outcome.projectionFailures).toBe(1);
    expect(outcome.admitted).toBe(5);
    // The batch survives whole: the four events whose projection succeeded are
    // projected, the timeline holds all five, and the loss is NAMED rather than
    // absorbed, because only a re-pull can supply the mutation that did not run.
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
    // A projector that returns a good mutation and then a malformed one. Merging
    // the first before the second threw would leave a partition holding half of a
    // transition nothing will ever complete.
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
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([eventAt(1)]);

    expect(outcome.projectionFailures).toBe(1);
    expect(store.snapshot().partitions.run).toStrictEqual({});
    expect(store.snapshot().degradedCause).toBe("projection-failed");
  });

  it("negative control: a projector that returns cleanly still projects and leaves no cause", () => {
    const store = storeWithProjectorThrowingAt(Number.NaN);
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([eventAt(1), eventAt(2)]);

    expect(outcome.projectionFailures).toBe(0);
    expect(Object.keys(store.snapshot().partitions.run).sort()).toStrictEqual(["run-1", "run-2"]);
    expect(store.snapshot().degradedCause).toBeUndefined();
  });
});
