// The per-session store's apply chokepoint, each mode asserted on the refusal or the recorded
// loss rather than the absence of a crash, since not throwing is not behaving correctly: an event
// that came early, one addressed elsewhere, one that skipped or repeated a sequence, a subscriber
// writing back during notification, a sequence cursor arithmetic cannot carry, a buffer whose read
// never came, a projector that throws, and a read whose rows imply entities; and the standing
// events, which outlive what the window lets go. A read landing on a store that already holds a
// window is `store.repair.test.ts`.

import { beforeEach, describe, expect, it } from "vitest";

import { windowTripwires } from "#renderer/lib/tripwires/registry.js";
import { eventOfKind } from "#test/helpers/session/events.js";
import type { EntityMutation, ProjectedSessionEvent } from "./entities/vocabulary.js";
import { PRE_INITIALIZATION_BUFFER_CAP } from "./caps.js";
import { SessionStore } from "./store.js";

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
    expect(store.snapshot().degradedCause).toBe("sequence-diverged");
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
    expect(store.snapshot().degradedCause).toBe("sequence-diverged");
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

describe("a read places a window whose rows imply entities", () => {
  // Each run row states its run in the state its kind names, its body naming the row it came
  // from; a row of `run-unreadable` throws.
  function storeProjectingRunRows(): SessionStore {
    const projectRunRow =
      (state: string) =>
      (event: ProjectedSessionEvent): readonly EntityMutation[] => {
        const runId = String(event.payload?.["runId"]);
        if (runId === "run-unreadable") {
          throw new TypeError("the payload was not the shape this projector claims");
        }
        return [
          {
            operation: "upsert",
            entity: { kind: "run", id: runId, state, body: { sequence: event.sequence } },
          },
        ];
      };
    return new SessionStore({
      sessionId: "session-1",
      projectors: {
        "run.running": projectRunRow("running"),
        "run.completed": projectRunRow("completed"),
      },
    });
  }

  function runRowAt(kind: string, sequence: number, runId: string): ProjectedSessionEvent {
    return eventOfKind("session-1", kind, sequence, { runId });
  }

  it("projects the runs its rows imply, an ended one too, under the read's records", () => {
    const store = storeProjectingRunRows();

    store.initialize({
      cursor: 3,
      entities: [
        {
          kind: "run",
          id: "run-live",
          state: "waiting",
          touchedAt: "2026-10-08T12:00:00.000Z",
          body: { agentId: "agent-1" },
        },
      ],
      transcript: [
        runRowAt("run.running", 1, "run-ended"),
        runRowAt("run.completed", 2, "run-ended"),
        runRowAt("run.running", 3, "run-live"),
      ],
    });

    // The record names live runs only, so the ended run comes from its rows alone.
    expect(store.snapshot().partitions.run).toStrictEqual({
      "run-ended": { kind: "run", id: "run-ended", state: "completed", body: { sequence: 2 } },
      "run-live": {
        kind: "run",
        id: "run-live",
        state: "waiting",
        touchedAt: "2026-10-08T12:00:00.000Z",
        body: { sequence: 3, agentId: "agent-1" },
      },
    });
    expect(store.snapshot().degradedCause).toBeUndefined();
  });

  it("names a read row a projector threw on, keeping what the other rows imply", () => {
    const store = storeProjectingRunRows();

    store.initialize({
      cursor: 2,
      entities: [],
      transcript: [
        runRowAt("run.running", 1, "run-unreadable"),
        runRowAt("run.running", 2, "run-a"),
      ],
    });

    expect(Object.keys(store.snapshot().partitions.run)).toStrictEqual(["run-a"]);
    expect(store.snapshot().degradedCause).toBe("projection-failed");
  });
});

describe("the standing events stand whatever rows the window holds", () => {
  it("keeps the newest of each kind from the read and the stream past a release", () => {
    const store = new SessionStore({ sessionId: "session-1" });
    const measuredAt = (sequence: number, runId: string): ProjectedSessionEvent =>
      eventOfKind("session-1", "usage.context_window_update", sequence, {
        runId,
        windowUsedTokens: 10,
        windowMaxTokens: 100,
      });
    store.initialize({
      cursor: 3,
      entities: [],
      // The birth row lies below the window; only the read carries it.
      standingEvents: [eventOfKind("session-1", "session.created", 1, { sessionId: "session-1" })],
      transcript: [measuredAt(2, "run-a"), eventAt(3)],
    });
    // A row that measures nothing never stands over the one that did.
    store.applyBatch([
      eventOfKind("session-1", "usage.context_window_update", 4, {
        runId: "run-a",
        exceeded: true,
      }),
      eventAt(5),
    ]);
    store.releaseBeyondNewest(1);
    const switchedAt = (sequence: number, agentId: string): ProjectedSessionEvent =>
      eventOfKind("session-1", "agent.provider_binding_changed", sequence, { agentId });
    store.applyBatch([
      measuredAt(6, "run-b"),
      eventOfKind("session-1", "pty.control_changed", 7, { terminalId: "shell-1" }),
      // Each agent's newest switch stands: the lead's second replaces its first.
      switchedAt(8, "agent-lead"),
      switchedAt(9, "agent-helper"),
      switchedAt(10, "agent-lead"),
    ]);

    expect(store.snapshot().transcript.map((event) => event.sequence)).toStrictEqual([5]);
    expect(store.snapshot().transcriptTail.following).toBe("detached");
    expect(store.snapshot().standingEvents.map((event) => event.sequence)).toStrictEqual([
      1, 2, 6, 7, 9, 10,
    ]);
  });
});

describe("the hue wheel follows the order agents joined", () => {
  it("draws the same hues for a session opened at its tail and at its head", () => {
    const actedBy = (event: ProjectedSessionEvent, actorId: string): ProjectedSessionEvent => ({
      ...event,
      actorId,
    });
    // The person opens the session with the lead, then brings in a helper from its definition.
    const joins = [
      actedBy(
        eventOfKind("session-1", "session.created", 1, {
          sessionId: "session-1",
          mainAgent: { agentId: "agent-lead" },
        }),
        "person-1",
      ),
      actedBy(
        eventOfKind("session-1", "run.queued", 2, {
          runId: "run-helper",
          resolvedAgent: { agentId: "agent-helper" },
        }),
        "person-1",
      ),
    ];
    const atHead = new SessionStore({ sessionId: "session-1" });
    atHead.initialize({
      cursor: 4,
      entities: [],
      standingEvents: joins,
      transcript: [...joins, actedBy(eventAt(3), "agent-lead"), actedBy(eventAt(4), "agent-lead")],
    });
    // The tail holds only the helper's rows, the lead's lying above the window.
    const atTail = new SessionStore({ sessionId: "session-1" });
    atTail.initialize({
      cursor: 91,
      entities: [],
      standingEvents: joins,
      transcript: [actedBy(eventAt(90), "agent-helper"), actedBy(eventAt(91), "agent-helper")],
    });

    for (const store of [atHead, atTail]) {
      const stepOf = (actorId: string): number | undefined =>
        store.hueAllocator.assignmentFor(actorId)?.step;
      expect([stepOf("person-1"), stepOf("agent-lead"), stepOf("agent-helper")]).toStrictEqual([
        0, 1, 2,
      ]);
    }
  });
});
