// What the registry this hook mints is wired with: a clock, the projectors, and the read. Both
// wirings are invisible in a snapshot (a store on the wrong clock still holds events, one with no
// projectors still holds a timeline), so each case drives the hook's registry and carries a
// same-class control with the one wiring removed.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { bridgeAnswering } from "@test/helpers/fixture-bridge.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { APPLY_COALESCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { RefusalError } from "@renderer/lib/refusal.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { EntityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import {
  RUN_LIFECYCLE_PROJECTOR_OWNER,
  RUN_LIFECYCLE_PROJECTORS,
} from "@renderer/store/session-events/run-lifecycle-projector.js";
import { sessionReadThroughDaemon } from "@renderer/services/daemon/session-read.js";
import {
  SessionProbe,
  fixtureBridgeHarness,
  fixtureBridgeWrapper,
  lastObservation,
  type Observation,
} from "./session-store-hooks.test-support.js";

/** One wire event, shaped as the apply chokepoint consumes it. */
function deliveredEvent(sessionId: string, sequence: number): ProjectedSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId,
    sequence,
    kind: "run.queued",
    occurredAt: new Date(sequence).toISOString(),
  };
}

/** One run beat, payload-shaped as the run-lifecycle taxonomy spells it. */
function queuedRunEvent(sessionId: string, sequence: number, runId: string): ProjectedSessionEvent {
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
    // The apply queue coalesces on a timeout of `APPLY_COALESCE_MS`, so which clock armed it is
    // observable: only advancing the scenario fires a frozen one, and a wall-clock timer never
    // fires from it.
    const { scenarioEngine, wrapper } = fixtureBridgeHarness();
    const sessionId = CONCURRENT_STREAMING_SCENARIO.sessionId;
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
    // Still buffered: enqueuing arms the window without spending it.
    expect(registry.applyDrainCountFor(sessionId)).toBe(drainsBefore);

    act(() => {
      scenarioEngine.advance(APPLY_COALESCE_MS);
    });

    expect(registry.applyDrainCountFor(sessionId)).toBeGreaterThan(drainsBefore);
  });

  it("negative control: a registry left on the real clock does not drain when scenario time moves", () => {
    // Without this, the case above would pass for a queue that drained on enqueue or on any
    // advance. Same registry class, no clock supplied, so it takes its own `RealClock`, and a
    // separate `ManualClock` advanced past the window reaches none of its timers.
    const registry = new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
    const unclockedSessionId = "session-wall-clock";
    registry.open(unclockedSessionId);
    const separateClock = new ManualClock();

    registry.enqueue(unclockedSessionId, [deliveredEvent(unclockedSessionId, 1)]);
    separateClock.advance(APPLY_COALESCE_MS * 4);

    expect(registry.applyDrainCountFor(unclockedSessionId)).toBe(0);
    // Disposed so its pending real timeout cannot drain during a later case.
    registry.disposeAll();
  });
});

describe("useSessionStoreRegistry — the projectors the window's stores fold with", () => {
  it("registers the run-lifecycle projectors on the stores it opens", () => {
    // Asserted through the registry the hook built, not a constructor spy: a mock would pass
    // even if the composition root registered nothing.
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
    // The base state the fixture's own read establishes, so a later read changes nothing.
    store?.initialize({ cursor: 0, entities: [] });

    act(() => {
      registry.enqueue(sessionId, [queuedRunEvent(sessionId, 1, "run-projection-1")]);
      registry.flush(sessionId);
    });

    const projectedRun = store?.snapshot().partitions.run["run-projection-1"];
    expect(projectedRun?.state).toBe("queued");
    expect(projectedRun?.body?.["runVersion"]).toBe(1);
  });

  it("negative control: a registry built with no projectors folds the same event into nothing", () => {
    // Without this, the case above would pass on any store that held a run row. Same class and
    // event with no projectors: the partition stays empty.
    const registry = new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
    const sessionId = "session-unprojected";
    const store = registry.open(sessionId);
    store.initialize({ cursor: 0, entities: [] });

    registry.enqueue(sessionId, [queuedRunEvent(sessionId, 1, "run-projection-1")]);
    registry.flush(sessionId);

    expect(store.snapshot().timeline).toHaveLength(1);
    expect(store.snapshot().partitions.run).toStrictEqual({});
    registry.disposeAll();
  });
});

describe("useSessionStoreRegistry — the board a feature projects its own events through", () => {
  /** An event kind no taxonomy registers, so only a registered claim can fold it. */
  const CLAIMED_EVENT_KIND = "approval.probe_raised";

  /** One beat of that kind, in the shape the apply chokepoint consumes. */
  function claimedEvent(sessionId: string, sequence: number): ProjectedSessionEvent {
    return {
      id: `event-${String(sequence)}`,
      sessionId,
      sequence,
      kind: CLAIMED_EVENT_KIND,
      occurredAt: new Date(sequence).toISOString(),
      payload: { approvalId: "approval-probe-1" },
    };
  }

  it("folds an event kind a feature claimed, in a store the window opened", () => {
    // A feature claims its fold on the board the window is handed, and the store the window
    // opens folds with it.
    const projectorRegistry = new EntityProjectorRegistry();
    projectorRegistry.registerAll(RUN_LIFECYCLE_PROJECTORS, RUN_LIFECYCLE_PROJECTOR_OWNER);
    projectorRegistry.register(
      CLAIMED_EVENT_KIND,
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
    const sessionId = "session-feature-projection";
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
    store?.initialize({ cursor: 0, entities: [] });

    act(() => {
      registry.enqueue(sessionId, [claimedEvent(sessionId, 1)]);
      registry.flush(sessionId);
    });

    expect(store?.snapshot().partitions.approval["approval-probe-1"]?.state).toBe("pending");
    // The run lifecycle's claim still stands: the board is shared, not replaced.
    expect(projectorRegistry.ownerOf("run.queued")).toBe(RUN_LIFECYCLE_PROJECTOR_OWNER);
  });

  it("negative control: the frame's own table alone folds that same event into nothing", () => {
    // With only the run-lifecycle table, the partition stays empty while the timeline still
    // records the arrival.
    const registry = new SessionStoreRegistry({
      read: () => Promise.resolve(undefined),
      projectors: RUN_LIFECYCLE_PROJECTORS,
    });
    const sessionId = "session-unclaimed-kind";
    const store = registry.open(sessionId);
    store.initialize({ cursor: 0, entities: [] });

    registry.enqueue(sessionId, [claimedEvent(sessionId, 1)]);
    registry.flush(sessionId);

    expect(store.snapshot().timeline).toHaveLength(1);
    expect(store.snapshot().partitions.approval).toStrictEqual({});
    registry.disposeAll();
  });
});

describe("sessionReadThroughDaemon — the base state a store opens on", () => {
  it("opens at the bottom of the stream and carries the daemon's cursor block unread", async () => {
    const { bridge } = bridgeAnswering((_call, passThrough) => passThrough());

    const snapshot = await sessionReadThroughDaemon(bridge)(
      CONCURRENT_STREAMING_SCENARIO.sessionId,
      [],
      undefined,
    );

    expect(snapshot).toStrictEqual({
      cursor: 0,
      entities: [],
      timelineCursors: { latest: "concurrent-streaming-cursor-45" },
    });
  });

  it("raises the refusal instead of reading nothing", async () => {
    const { bridge } = bridgeAnswering(() =>
      Promise.reject({ code: "session.not_found", message: "gone" }),
    );

    await expect(
      sessionReadThroughDaemon(bridge)(CONCURRENT_STREAMING_SCENARIO.sessionId, [], undefined),
    ).rejects.toBeInstanceOf(RefusalError);
  });
});
