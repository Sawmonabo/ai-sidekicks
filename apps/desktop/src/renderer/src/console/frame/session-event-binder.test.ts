// The wire reaches the store, and only through the one door.
//
// Everything here runs against the REAL fixture bridge playing the REAL flagship
// scenario on the REAL frozen clock the engine builds. That is not ceremony: the
// gap this class closes was that `SessionStoreRegistry.enqueue` had no caller and
// nothing subscribed to `daemon.subscribe`, and a test driving a hand-written
// stand-in for either end would have passed over exactly that gap.
//
// Each case has a control that fails the way the regression would. The sharpest
// one is the first: without the binder, the same scenario advanced the same way
// reaches the registry not at all — so "the count grew" is a claim about this
// class rather than about the fixture being noisy.

import { beforeEach, describe, expect, it } from "vitest";

import { createFixtureBridge, growthUnavailable } from "../bridge/index.js";
import type { ConsoleScenario, ScenarioEngine } from "../bridge/scenario.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { APPLY_COALESCE_MS, ManualClock, consoleTripwires } from "../core/index.js";
import { SessionStoreRegistry, type ConsoleSessionEvent } from "../store/index.js";
import { SESSION_DIAGNOSTICS_FIXTURE_GLOBAL, SessionEventBinder } from "./session-event-binder.js";
import type { ConsoleSessionDiagnostics } from "./session-event-binder.js";

const SESSION_ID = FLAGSHIP_SCENARIO.sessionId;

/**
 * The frozen time that delivers the whole scenario, and the time that delivers its
 * opening only — both read off the script rather than restated beside it.
 *
 * Literals here were copies of the flagship's own timings, and they went stale the
 * first time it grew: the "whole scenario" advance stopped part-way through and the
 * partial-delivery count named beats the re-timed opening no longer put in reach.
 */
const PAST_EVERY_BEAT_MS = (FLAGSHIP_SCENARIO.beats.at(-1)?.atMs ?? 0) + 100;

const THROUGH_THIRD_BEAT_MS = FLAGSHIP_SCENARIO.beats[2]?.atMs ?? 0;
const BEATS_THROUGH_THIRD_BEAT = FLAGSHIP_SCENARIO.beats.filter(
  (beat) => beat.atMs <= THROUGH_THIRD_BEAT_MS,
).length;

interface BinderHarness {
  readonly registry: SessionStoreRegistry;
  readonly binder: SessionEventBinder;
  readonly engine: ScenarioEngine;
}

/**
 * A registry, a fixture bridge, and a binder over both.
 *
 * The registry is given the ENGINE's clock rather than one of its own, because
 * there is exactly one clock in fixture mode and a second one would let the apply
 * queue's coalescing window and the scenario's beats drift apart — which would make
 * every timing assertion below a measurement of the harness.
 */
function createHarness(scenario: ConsoleScenario = FLAGSHIP_SCENARIO): BinderHarness {
  const bridge = createFixtureBridge({ scenario });
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture bridge built no scenario engine, so there is nothing to drive");
  }
  const registry = new SessionStoreRegistry({
    // A REGISTERED read that happens to find nothing — the transient miss, which
    // is what a session whose wire exists looks like between reads. It has to be
    // registered for the binder to bind at all (the suppressed arm is its own case
    // below), and it has to resolve `undefined` rather than a snapshot, because a
    // snapshot would initialise the stores and change what `applyBatch` does with
    // every event these cases deliver.
    read: () => Promise.resolve(undefined),
    clock: engine.clock,
  });
  return { registry, binder: new SessionEventBinder({ registry, bridge }), engine };
}

/** The same three pieces, over a registry that has no read to perform at all. */
function createUnreadableHarness(): BinderHarness {
  const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture bridge built no scenario engine, so there is nothing to drive");
  }
  const registry = new SessionStoreRegistry({
    // The refusal a bridge that does not serve the session read hands over — the
    // real one the composition root would pass, built by the same function, not a
    // stand-in shaped like it.
    read: growthUnavailable("sessionRead"),
    clock: engine.clock,
  });
  return { registry, binder: new SessionEventBinder({ registry, bridge }), engine };
}

/** The page slot the fixture diagnostics are hung on, read as the tier reads it. */
function readInstalledDiagnostics(): ConsoleSessionDiagnostics | undefined {
  return (globalThis as Record<string, unknown>)[SESSION_DIAGNOSTICS_FIXTURE_GLOBAL] as
    | ConsoleSessionDiagnostics
    | undefined;
}

// Tripwires throw in development so a breach is impossible to ignore. Under test
// they are RECORDED instead, because these cases assert that a breach was detected
// and described — a throw would only prove it was noticed.
beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

describe("SessionEventBinder — the console's one subscription to the wire", () => {
  it("admits every beat of an open session to the apply chokepoint", () => {
    const { registry, binder, engine } = createHarness();
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(PAST_EVERY_BEAT_MS);

    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(FLAGSHIP_SCENARIO.beats.length);
    expect(binder.boundSessionIds).toEqual([SESSION_ID]);
    expect(binder.droppedAfterCloseCount).toBe(0);
    expect(binder.unreadableDeliveryCount).toBe(0);

    // The count above is an ADMISSION count, so it moves before the queue drains.
    // Draining is the half that proves the events actually reached the store's
    // chokepoint rather than sitting in a queue nothing ever empties.
    engine.advance(APPLY_COALESCE_MS + 1);
    expect(registry.applyDrainCountFor(SESSION_ID)).toBeGreaterThan(0);

    binder.dispose();
  });

  it("negative control: the same scenario reaches a registry with no binder not at all", () => {
    // The control that makes the case above non-vacuous. Same registry, same
    // bridge, same advance — and the only difference is that nothing subscribes.
    const { registry, engine } = createHarness();
    registry.open(SESSION_ID);

    engine.advance(PAST_EVERY_BEAT_MS);
    engine.advance(APPLY_COALESCE_MS + 1);

    expect(registry.applyDrainCountFor(SESSION_ID)).toBe(0);
    expect(registry.peek(SESSION_ID)?.snapshot().timeline).toEqual([]);
  });

  it("binds a session that was already open before it attached", () => {
    // The lost-open race, driven in the order that loses it: the session is open
    // before the binder ever subscribes to the registry, so a binder that only
    // listened for CHANGES would never hear about this one.
    const { registry, binder, engine } = createHarness();
    registry.open(SESSION_ID);
    binder.attach();

    engine.advance(PAST_EVERY_BEAT_MS);

    expect(binder.boundSessionIds).toEqual([SESSION_ID]);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(FLAGSHIP_SCENARIO.beats.length);

    binder.dispose();
  });

  it("stops delivering when the session closes, and freezes the count there", () => {
    const { registry, binder, engine } = createHarness();
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(THROUGH_THIRD_BEAT_MS);
    const countAtClose = binder.appliedEventCountFor(SESSION_ID);
    registry.close(SESSION_ID);
    engine.advance(PAST_EVERY_BEAT_MS);

    expect(countAtClose).toBe(BEATS_THROUGH_THIRD_BEAT);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(countAtClose);
    expect(binder.boundSessionIds).toEqual([]);
    // The subscription is released rather than merely ignored: a binder that kept
    // filtering after the close would leave the wire delivering into this window
    // for the rest of its life.
    expect(engine.sinkCount).toBe(0);
    // Nothing raced, so nothing was dropped — which is what distinguishes this
    // case from the one below rather than the two sharing an outcome.
    expect(binder.droppedAfterCloseCount).toBe(0);

    binder.dispose();
  });

  it("drops a delivery that races a close, counts it, and reports it", () => {
    // The race is real: emission iterates a SNAPSHOT of the subscribers, so a
    // listener that closes the session part-way through a delivery leaves this
    // binder's handler in the batch still being delivered.
    const { registry, binder, engine } = createHarness();
    engine.subscribe(() => {
      registry.close(SESSION_ID);
    });
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(1);

    expect(binder.droppedAfterCloseCount).toBe(1);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(0);
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    expect(consoleTripwires.reports().at(-1)?.site).toBe("console/frame/session-event-binder.ts");

    binder.dispose();
  });

  it("negative control: a delivery to a session that is open reports nothing", () => {
    // Without this, the case above would pass on any tripwire firing at all — the
    // scenario engine reports on the same kind when a tick arrives after teardown.
    const { registry, binder, engine } = createHarness();
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(1);

    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(1);
    expect(binder.droppedAfterCloseCount).toBe(0);
    expect(consoleTripwires.totalFiringCount).toBe(0);

    binder.dispose();
  });

  it("releases every subscription on dispose, and disposes safely twice", () => {
    const { registry, binder, engine } = createHarness();
    binder.attach();
    registry.open(SESSION_ID);
    engine.advance(THROUGH_THIRD_BEAT_MS);
    const countAtDispose = binder.appliedEventCountFor(SESSION_ID);
    // Non-zero before the teardown, or "the count froze" below would hold over a
    // binder that had never delivered anything in the first place.
    expect(countAtDispose).toBe(BEATS_THROUGH_THIRD_BEAT);
    expect(engine.sinkCount).toBeGreaterThan(0);
    expect(registry.listenerCount).toBeGreaterThan(0);

    binder.dispose();
    binder.dispose();
    engine.advance(PAST_EVERY_BEAT_MS);

    expect(binder.isDisposed).toBe(true);
    expect(binder.boundSessionIds).toEqual([]);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(countAtDispose);
    // Both subscriptions are gone: the wire's, and the registry's own change feed.
    expect(engine.sinkCount).toBe(0);
    expect(registry.listenerCount).toBe(0);
    // A disposed binder cannot start again from a late effect — otherwise a
    // remounting frame would leave the previous window's binder subscribed.
    binder.attach();
    expect(registry.listenerCount).toBe(0);
  });

  it("refuses a delivered payload that is not a session event, and counts it", () => {
    const malformed: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "flagship-malformed-payload-probe",
      beats: [
        {
          atMs: 0,
          // Deliberately not a session event. The cast is the point of the case:
          // the wire hands the console an `unknown`, and the boundary is the only
          // thing standing between a shape like this and a store that would hold
          // it at a type saying its fields are readable.
          event: { sequence: 1 } as unknown as ConsoleSessionEvent,
        },
      ],
    };
    const { registry, binder, engine } = createHarness(malformed);
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(1);

    expect(binder.unreadableDeliveryCount).toBe(1);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(0);
    // Counted, and deliberately not reported: an unfamiliar payload is a fact
    // about the wire, and a tripwire would name it a defect in the console.
    expect(consoleTripwires.totalFiringCount).toBe(0);

    binder.dispose();
  });

  it("exposes the fixture diagnostics while attached, and removes them on dispose", () => {
    // Read before attaching, so the presence assertion below cannot be satisfied
    // by a handle some earlier case left behind.
    expect(readInstalledDiagnostics()).toBeUndefined();

    const { registry, binder, engine } = createHarness();
    binder.attach();
    registry.open(SESSION_ID);
    engine.advance(PAST_EVERY_BEAT_MS);

    const diagnostics = readInstalledDiagnostics();
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.openSessionIds()).toEqual([SESSION_ID]);
    expect(diagnostics?.boundSessionIds()).toEqual([SESSION_ID]);
    expect(diagnostics?.appliedEventCountFor(SESSION_ID)).toBe(FLAGSHIP_SCENARIO.beats.length);
    expect(diagnostics?.appliedEventCountFor("session-nobody-opened")).toBe(0);

    binder.dispose();
    expect(readInstalledDiagnostics()).toBeUndefined();
  });

  it("binds nothing when the registry can initialise no store, so nothing accumulates", () => {
    // The leak this closes: with no session-read wire registered, `initialise` is
    // never called, so every delivered event buffers inside the store and is
    // projected by nothing. A long-running session held its whole stream that way.
    const { registry, binder, engine } = createUnreadableHarness();
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(PAST_EVERY_BEAT_MS);
    engine.advance(APPLY_COALESCE_MS + 1);

    expect(registry.canInitialiseSessionStores).toBe(false);
    expect(binder.boundSessionIds).toEqual([]);
    // No wire subscription at all, rather than one whose deliveries are discarded:
    // a filter still pays for every frame the engine emits.
    expect(engine.sinkCount).toBe(0);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(0);
    expect(registry.peek(SESSION_ID)?.pendingPreInitialisationCount).toBe(0);
    expect(registry.peek(SESSION_ID)?.snapshot().timeline).toEqual([]);
    // The diagnostics handle is still installed: a tier reading zero bound sessions
    // is a reading, and an absent handle would be indistinguishable from a build
    // that has no binder in it at all.
    expect(readInstalledDiagnostics()?.boundSessionIds()).toEqual([]);
    expect(readInstalledDiagnostics()?.openSessionIds()).toEqual([SESSION_ID]);

    binder.dispose();
  });

  it("asks for the base-state read in the same act as taking the subscription", async () => {
    // The gap this closes: nothing in the console called `requestRefresh` on an
    // open, so even a registry with a working read never performed one — every
    // bound session buffered its stream against a store that was never
    // initialised. The control is the count itself: it is zero without the
    // request, and the timeline stays empty however many beats arrive.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const engine = bridge.scenarioEngine;
    if (engine === undefined) {
      throw new Error("the fixture bridge built no scenario engine, so there is nothing to drive");
    }
    const reasonsSeen: string[] = [];
    const registry = new SessionStoreRegistry({
      read: (_sessionId, reasons) => {
        reasonsSeen.push(...reasons);
        return Promise.resolve({ cursor: 0, entities: [], participantJoinLog: [] });
      },
      clock: engine.clock,
      refreshDebounceMs: 0,
    });
    const binder = new SessionEventBinder({ registry, bridge });
    binder.attach();
    registry.open(SESSION_ID);

    // The scheduler debounces on the frozen clock, so the read lands on an advance
    // rather than on a turn of the microtask queue.
    engine.advance(1);
    await Promise.resolve();

    expect(reasonsSeen).toEqual(["subscribe"]);
    expect(registry.refreshCountFor(SESSION_ID)).toBe(1);
    expect(registry.peek(SESSION_ID)?.snapshot().initialised).toBe(true);

    engine.advance(PAST_EVERY_BEAT_MS);
    engine.advance(APPLY_COALESCE_MS + 1);
    expect(registry.peek(SESSION_ID)?.snapshot().timeline).toHaveLength(
      FLAGSHIP_SCENARIO.beats.length,
    );

    binder.dispose();
  });

  it("harness integrity: the fixture engine drives the real frozen clock", () => {
    // The cases above measure coalescing windows in frozen milliseconds, which
    // only means anything if the clock underneath is the manual one. A real clock
    // here would make every advance a no-op that the assertions would not notice.
    const { engine } = createHarness();
    expect(engine.clock).toBeInstanceOf(ManualClock);
  });
});
