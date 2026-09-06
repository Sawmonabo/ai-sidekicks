// What the registry this hook mints is WIRED with: a clock, and the projectors.
//
// Both are properties of the composition root rather than of the registry class,
// and both are invisible in a snapshot — a store on the wrong clock still holds
// events, and a store with no projectors still holds a timeline. So each case
// drives the registry the hook actually built and carries the same-class control
// with the one wiring difference removed: a registry left on its own `RealClock`
// reaches none of the scenario's timers, and a registry built with no projectors
// folds the same event into an empty partition. That second state is what the
// console shipped before.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../bridge/index.js";
import type { ScenarioEngine } from "../bridge/scenario-runtime/scenario-engine.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { APPLY_COALESCE_MS, ManualClock } from "../core/index.js";
import {
  ConsoleEntityProjectorRegistry,
  SessionStoreRegistry,
  type ConsoleSessionEvent,
} from "../store/index.js";
import { RUN_LIFECYCLE_PROJECTORS } from "./run-lifecycle-projector.js";
import {
  SessionProbe,
  fixtureBridgeHarness,
  fixtureBridgeWrapper,
  lastObservation,
  type Observation,
} from "./session-lifecycle.test-support.js";

/** The running engine, or a failure that names what was missing rather than `undefined`. */
function scenarioEngineOf(bridge: ConsoleBridge): ScenarioEngine {
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture bridge exposed no scenario engine");
  }
  return engine;
}

/** One wire event, shaped as the apply chokepoint consumes it. */
function deliveredEvent(sessionId: string, sequence: number): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId,
    sequence,
    kind: "run.queued",
    occurredAt: new Date(sequence).toISOString(),
  };
}

/** One run beat, payload-shaped as `Spec-006 §Run Lifecycle (run_lifecycle)` spells it. */
function queuedRunEvent(sessionId: string, sequence: number, runId: string): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId,
    sequence,
    kind: "run.queued",
    occurredAt: new Date(sequence).toISOString(),
    payload: { sessionId, runId, runVersion: 1, newState: "queued" },
  };
}

describe("useSessionStoreRegistry — the clock the window's stores run on", () => {
  it("drains a queued batch on the scenario's frozen clock rather than on wall time", () => {
    // The apply queue coalesces on a TIMEOUT of `APPLY_COALESCE_MS`, so which
    // clock armed it is observable: advancing the scenario is the only thing that
    // can fire a frozen one, and it fires nothing at all on a wall-clock timer.
    // Before the registry was handed the bridge's clock, this drain waited on
    // `setTimeout` while the beats around it moved on frozen time — so a
    // screenshot or an endurance step taken straight after `advance()` saw either
    // side of the drain depending on how fast the runner was.
    const { bridge, wrapper } = fixtureBridgeHarness();
    const sessionId = FLAGSHIP_SCENARIO.sessionId;
    const observed: Observation[] = [];
    render(
      <SessionProbe
        sessionId={sessionId}
        onObserve={(observation) => {
          observed.push(observation);
        }}
      />,
      { wrapper },
    );
    const { registry } = lastObservation(observed);
    const drainsBefore = registry.applyDrainCountFor(sessionId);

    act(() => {
      registry.enqueue(sessionId, [deliveredEvent(sessionId, 1)]);
    });
    // Still buffered: enqueuing arms the window, it does not spend it.
    expect(registry.applyDrainCountFor(sessionId)).toBe(drainsBefore);

    act(() => {
      scenarioEngineOf(bridge).advance(APPLY_COALESCE_MS);
    });

    expect(registry.applyDrainCountFor(sessionId)).toBeGreaterThan(drainsBefore);
  });

  it("negative control: a registry left on the real clock does not drain when scenario time moves", () => {
    // Without this, the case above would pass against a queue that drained on
    // enqueue, on any advance, or on nothing in particular. This is the SAME
    // registry class with the one difference under test — no clock supplied, so
    // it takes its own `RealClock` — and a separate `ManualClock` advanced past
    // the coalescing window reaches none of its timers.
    const registry = new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
    const unclockedSessionId = "session-wall-clock";
    registry.open(unclockedSessionId);
    const separateClock = new ManualClock();

    registry.enqueue(unclockedSessionId, [deliveredEvent(unclockedSessionId, 1)]);
    separateClock.advance(APPLY_COALESCE_MS * 4);

    expect(registry.applyDrainCountFor(unclockedSessionId)).toBe(0);
    // Disposed rather than left armed: its real timeout is still pending, and a
    // drain landing in a later case's turn is a cross-test coupling.
    registry.disposeAll();
  });
});

describe("useSessionStoreRegistry — the projectors the window's stores fold with", () => {
  it("registers the run-lifecycle projectors on the stores it opens", () => {
    // Asserted THROUGH the registry the hook built rather than against a
    // constructor spy: what matters is that a store this window opens folds a
    // `run.*` event into the `run` partition, and a mock of the registry would
    // have passed with the composition root registering nothing at all — which is
    // exactly the state this replaced.
    const observed: Observation[] = [];
    const sessionId = "session-run-projection";
    render(
      <SessionProbe
        sessionId={sessionId}
        onObserve={(observation) => {
          observed.push(observation);
        }}
      />,
      { wrapper: fixtureBridgeWrapper() },
    );
    const { registry } = lastObservation(observed);
    const store = registry.peek(sessionId);
    expect(store).toBeDefined();
    // The same base state the fixture's own session read establishes, so a read
    // landing later answers at this cursor and changes nothing.
    store?.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    act(() => {
      registry.enqueue(sessionId, [queuedRunEvent(sessionId, 1, "run-projection-1")]);
      registry.flush(sessionId);
    });

    const projectedRun = store?.snapshot().partitions.run["run-projection-1"];
    expect(projectedRun?.state).toBe("queued");
    expect(projectedRun?.body?.["runVersion"]).toBe(1);
  });

  it("negative control: a registry built with no projectors folds the same event into nothing", () => {
    // Without this, the case above would pass on any store that happened to hold
    // a run row. Same registry class, same event, one difference — no projectors —
    // and the partition stays empty, which is what the console shipped before.
    const registry = new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
    const sessionId = "session-unprojected";
    const store = registry.open(sessionId);
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    registry.enqueue(sessionId, [queuedRunEvent(sessionId, 1, "run-projection-1")]);
    registry.flush(sessionId);

    expect(store.snapshot().timeline).toHaveLength(1);
    expect(store.snapshot().partitions.run).toStrictEqual({});
    registry.disposeAll();
  });
});

describe("useSessionStoreRegistry — the board a family projects its own events through", () => {
  /** An event kind no taxonomy registers, so only a registered claim can fold it. */
  const FAMILY_EVENT_KIND = "approval.probe_raised";

  /** One beat of that kind, in the shape the apply chokepoint consumes. */
  function familyEvent(sessionId: string, sequence: number): ConsoleSessionEvent {
    return {
      id: `event-${String(sequence)}`,
      sessionId,
      sequence,
      kind: FAMILY_EVENT_KIND,
      occurredAt: new Date(sequence).toISOString(),
      payload: { approvalId: "approval-probe-1" },
    };
  }

  it("folds an event kind a family claimed, in a store the window opened", () => {
    // The whole point of the seam. `store/entities.ts` declares an `approval`
    // partition and every other family's besides, and under the frame's constant
    // table not one of them had a possible producer: a family could only fill its own
    // partition by reading the wire a second time, beside the store rather than in
    // it. Here the fold is claimed on a board the window is handed, and the store the
    // window opens folds with it.
    const projectorRegistry = new ConsoleEntityProjectorRegistry();
    projectorRegistry.registerAll(RUN_LIFECYCLE_PROJECTORS, "frame");
    projectorRegistry.register(
      FAMILY_EVENT_KIND,
      (event) => [
        {
          operation: "upsert",
          entity: {
            kind: "approval",
            id: String(event.payload?.["approvalId"]),
            state: "pending",
          },
        },
      ],
      "composer",
    );

    const observed: Observation[] = [];
    const sessionId = "session-family-projection";
    render(
      <SessionProbe
        sessionId={sessionId}
        projectorRegistry={projectorRegistry}
        onObserve={(observation) => {
          observed.push(observation);
        }}
      />,
      { wrapper: fixtureBridgeWrapper() },
    );
    const { registry } = lastObservation(observed);
    const store = registry.peek(sessionId);
    store?.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    act(() => {
      registry.enqueue(sessionId, [familyEvent(sessionId, 1)]);
      registry.flush(sessionId);
    });

    expect(store?.snapshot().partitions.approval["approval-probe-1"]?.state).toBe("pending");
    // The frame's own claim still stands beside it: a board is shared, not replaced.
    expect(projectorRegistry.ownerOf("run.queued")).toBe("frame");
  });

  it("negative control: the frame's own table alone folds that same event into nothing", () => {
    // The constant path, exactly as it was. Same registry class, same event, one
    // difference — the fold is the frame's table and nothing else — and the partition
    // stays empty while the timeline still records the arrival. That is the state
    // every family's surface would have been built against.
    const registry = new SessionStoreRegistry({
      read: () => Promise.resolve(undefined),
      projectors: RUN_LIFECYCLE_PROJECTORS,
    });
    const sessionId = "session-unclaimed-kind";
    const store = registry.open(sessionId);
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    registry.enqueue(sessionId, [familyEvent(sessionId, 1)]);
    registry.flush(sessionId);

    expect(store.snapshot().timeline).toHaveLength(1);
    expect(store.snapshot().partitions.approval).toStrictEqual({});
    registry.disposeAll();
  });
});
