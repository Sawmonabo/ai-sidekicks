// The per-session store's apply chokepoint and its repair, each mode asserted on the refusal or
// the recorded loss rather than the absence of a crash, since not throwing is not behaving
// correctly: an event that came early, one addressed elsewhere, one that skipped or repeated a
// sequence, a subscriber writing back during notification, a sequence cursor arithmetic cannot
// carry, the repair read answering at the cursor the store already reached, a buffer whose read
// never came, and a projector that throws.

import { beforeEach, describe, expect, it } from "vitest";

import { windowTripwires } from "@renderer/lib/tripwires.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import type { ProjectedSessionEvent } from "./entities/entities.js";
import { PRE_INITIALIZATION_BUFFER_CAP } from "./session-store-caps.js";
import { SessionStore } from "./session-store.js";

/**
 * One event at `sequence` on the session every case drives, with overrides that make one member
 * wrong at a time. Several cases deliver sequences `Date` cannot represent (`NaN`, infinities),
 * so the event literal comes from the helper that tolerates them.
 */
function eventAt(
  sequence: number,
  overrides: Partial<ProjectedSessionEvent> = {},
): ProjectedSessionEvent {
  return { ...eventOfKind("session-1", "run.starting", sequence), ...overrides };
}

// Tripwires throw in development. Under test they are recorded, since the re-entrancy case
// asserts the breach was detected and described; a throw would only prove it was noticed.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("the apply chokepoint admits what arrives, in order and once", () => {
  it("buffers rather than dropping, and drains in sequence order once initialized", () => {
    const store = new SessionStore({ sessionId: "session-1" });

    const early = store.applyBatch([eventAt(3), eventAt(2)]);
    expect(early.admitted).toBe(0);
    expect(early.buffered).toBe(2);
    expect(store.snapshot().transcript).toHaveLength(0);

    store.initialize({ cursor: 1, entities: [] });

    // Both buffered events land ordered with no gap: they were only early, never missing.
    const transcript = store.snapshot().transcript;
    expect(transcript.map((event) => event.sequence)).toStrictEqual([2, 3]);
    expect(store.snapshot().gaps).toStrictEqual([]);
    expect(store.snapshot().cursor).toBe(3);
  });

  it("refuses an event addressed to another session instead of mixing it in", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([eventAt(1, { sessionId: "session-2" })]);

    expect(outcome.refusedForeignSession).toBe(1);
    expect(outcome.admitted).toBe(0);
    expect(store.snapshot().transcript).toHaveLength(0);
  });

  it("records the missing sequences when a gap opens rather than renumbering", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([eventAt(1), eventAt(4)]);

    expect(outcome.gapDetected).toBe(true);
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 2, toSequence: 3 }]);
  });

  it("queues the re-entrant batch, applies it, and names the subscriber as the defect", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    let hasReentered = false;
    const unsubscribe = store.readable.subscribe(() => {
      if (hasReentered) {
        return;
      }
      hasReentered = true;
      // Models an effect writing during notification, which unguarded would interleave two
      // transitions with the second's `current` already stale.
      store.applyBatch([eventAt(2)]);
    });

    const outcome = store.applyBatch([eventAt(1)]);
    unsubscribe();

    expect(outcome.admitted).toBe(1);
    // The re-entrant events are applied after the outer batch settles, and the breach is recorded.
    expect(store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([1, 2]);
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    const report = windowTripwires.reports()[0];
    expect(report?.detail).toContain("re-entrant applyBatch");
  });

  it("applies a duplicate sequence exactly once", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    store.applyBatch([eventAt(1)]);
    const second = store.applyBatch([eventAt(1)]);

    expect(second.duplicates).toBe(1);
    expect(second.admitted).toBe(0);
    expect(store.snapshot().transcript).toHaveLength(1);
  });
});

describe("a delivered sequence the store cannot reconcile", () => {
  // The per-case timeout is part of the claim: enumerating the jump would take far longer.
  it("settles a jump of a billion into the repair path instead of enumerating it", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([eventAt(1_000_000_000)]);

    // Nothing is admitted or enumerated; walking a billion-wide hole would cost the frame budget.
    expect(outcome.refusedDivergedSequence).toBe(1);
    expect(outcome.admitted).toBe(0);
    expect(store.snapshot().gaps).toStrictEqual([]);
    expect(store.snapshot().transcript).toHaveLength(0);
    // The cursor stays where a read can answer at or ahead of it; a billion would make repairs
    // rewinds.
    expect(store.snapshot().cursor).toBe(0);
    expect(store.snapshot().degradedCause).toBe("stream-diverged");
  }, 2000);

  it("refuses a sequence too large to increment reliably rather than poisoning the cursor", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([
      eventAt(Number.MAX_SAFE_INTEGER),
      eventAt(Number.MAX_SAFE_INTEGER + 2),
      eventAt(Number.NaN),
      eventAt(Number.POSITIVE_INFINITY),
      eventAt(1.5),
    ]);

    expect(outcome.refusedDivergedSequence).toBe(5);
    expect(outcome.admitted).toBe(0);
    // The cursor is still a number a later comparison can act on; `NaN` would break every guard.
    expect(store.snapshot().cursor).toBe(0);
    expect(store.snapshot().degradedCause).toBe("stream-diverged");
  });

  it("orders the rest of a batch normally even with an unusable sequence in it", () => {
    // A subtracting comparator answers `NaN` here and leaves the batch order undefined; one
    // hostile sequence must not decide where the real ones land.
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });

    const outcome = store.applyBatch([eventAt(3), eventAt(Number.NaN), eventAt(1)]);

    expect(outcome.refusedDivergedSequence).toBe(1);
    expect(outcome.admitted).toBe(2);
    // Ordered, with the hole named once (a subtracting comparator would sort `[3, NaN, 1]`).
    expect(store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([1, 3]);
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 2, toSequence: 2 }]);
  });
});

describe("the repair read answers at the cursor the store already reached", () => {
  /**
   * A store that admitted event 7 over cursor 5: its cursor is 7, sequence 6 is missing and the
   * sticky flag is set. An authoritative re-pull answers through 7, the same cursor.
   */
  function degradedAtCursorSeven(): SessionStore {
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 5, entities: [] });
    store.apply(eventAt(7));
    return store;
  }

  it("admits an equal-cursor base state into a degraded store and clears the gap", () => {
    const store = degradedAtCursorSeven();
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 6, toSequence: 6 }]);

    store.initialize({
      cursor: 7,
      entities: [],
      transcript: [eventAt(6), eventAt(7)],
    });

    // Discarding this base state would leave 6 missing and the banner stuck.
    expect(store.snapshot().degradedCause).toBeUndefined();
    expect(store.snapshot().gaps).toStrictEqual([]);
    expect(store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([6, 7]);
  });

  it("still refuses a base state BEHIND the cursor, so a racing re-read cannot rewind", () => {
    const store = degradedAtCursorSeven();
    const before = store.snapshot();

    store.initialize({
      cursor: 6,
      entities: [],
      transcript: [eventAt(6)],
    });

    // Same state object: the guard returned before any transition, so event 7 is kept.
    expect(store.snapshot()).toBe(before);
    expect(store.snapshot().cursor).toBe(7);
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
  });

  it("leaves a HEALTHY store untouched by an equal-cursor base state", () => {
    // Guards against admitting every equal-cursor base state, which would rebuild the projection on
    // each focus refresh and empty the transcript for a base state carrying none.
    const store = new SessionStore({ sessionId: "session-1" });
    store.initialize({ cursor: 0, entities: [] });
    store.apply(eventAt(1));
    const before = store.snapshot();

    store.initialize({ cursor: 1, entities: [] });

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

describe("events arrive before initialization and the read never comes", () => {
  function eventsFrom(count: number): ProjectedSessionEvent[] {
    return Array.from({ length: count }, (_unused, index) => eventAt(index + 1));
  }

  it("re-derives exactly which sequences the cap cost, once a base state arrives", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    const overflowBy = 3;
    store.applyBatch(eventsFrom(PRE_INITIALIZATION_BUFFER_CAP + overflowBy));

    store.initialize({ cursor: 0, entities: [] });

    const transcript = store.snapshot().transcript;
    expect(transcript).toHaveLength(PRE_INITIALIZATION_BUFFER_CAP);
    expect(transcript[0]?.sequence).toBe(overflowBy + 1);
    expect(store.pendingPreInitializationCount).toBe(0);
    // The dropped sequences are named: the drain runs the same gap detection as any admission.
    expect(store.snapshot().gaps).toStrictEqual([{ fromSequence: 1, toSequence: 3 }]);
    expect(store.snapshot().degradedCause).toBe("sequence-gap");
  });
});

describe("a registered projector throws on an event", () => {
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
    expect(store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([
      1, 2, 3, 4, 5,
    ]);
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
});
