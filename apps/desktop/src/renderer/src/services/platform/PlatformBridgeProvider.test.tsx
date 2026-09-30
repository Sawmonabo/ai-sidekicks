// The resolved bridge is a resource with a lifetime, not a cached computation. A discarded
// `useMemo` would start a second `ScenarioEngine` at tick zero and abandon the first mid-scenario,
// and a replaced scenario would dispose nothing, leaving the old engine subscribable. So the cases
// are about identity and teardown; a memo can keep an identity but never dispose one. The
// composition is a recording one built here, so what is asserted is the provider's contract with
// any composition: build once, install once, take both down, dispose only what it built.

import { render } from "@testing-library/react";
import { StrictMode, useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { type Clock } from "@renderer/lib/clock.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { type ScenarioEngine } from "../daemon/engine.fixture.js";
import { PlatformBridgeProvider } from "./PlatformBridgeProvider.js";
import { useBridgeResolution } from "./hooks/useBridgeResolution.js";
import { useBridgeClock, useClock } from "./hooks/useClock.js";
import { type BridgeComposition } from "./bridge-context.js";
import { type PlatformBridge } from "./platform-bridge.js";
import { createFixtureBridge, type FixtureBridge } from "./platform-bridge.fixture.js";
import { findScenario } from "../../../../../fixtures/index.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../../../fixtures/scenarios/first-run.js";
import {
  CONCURRENT_STREAMING_SCENARIO,
  CONCURRENT_STREAMING_SCENARIO_ID,
} from "../../../../../fixtures/scenarios/concurrent-streaming.js";

interface BridgeProbeProps {
  readonly onObserve: (bridge: PlatformBridge) => void;
}

/** A component that does exactly what any view does: read the bridge. */
function BridgeProbe(props: BridgeProbeProps): null {
  const resolution = useBridgeResolution();
  if (resolution.status === "ready") {
    props.onObserve(resolution.bridge);
  }
  return null;
}

function lastBridge(observed: readonly PlatformBridge[]): PlatformBridge {
  const bridge = observed.at(-1);
  if (bridge === undefined) {
    throw new Error("the probe never saw a resolved bridge");
  }
  return bridge;
}

/**
 * A composition that plays one scenario and records what it built: the engine behind each
 * bridge, and which bridges hold handles.
 */
interface RecordingComposition extends BridgeComposition {
  readonly bridgesWithHandles: ReadonlySet<PlatformBridge>;
  engineOf(bridge: PlatformBridge): ScenarioEngine;
}

function recordingComposition(scenarioId: string): RecordingComposition {
  const scenario = findScenario(scenarioId);
  const bridgesWithHandles = new Set<PlatformBridge>();
  const engineByBridge = new Map<PlatformBridge, ScenarioEngine>();
  return {
    bridgesWithHandles,
    engineOf: (bridge) => {
      const engine = engineByBridge.get(bridge);
      if (engine === undefined) {
        throw new Error("this composition built no such bridge, so there is no engine to hold");
      }
      return engine;
    },
    createBridge: () => {
      const { bridge, scenarioEngine } = createFixtureBridge({ scenario });
      engineByBridge.set(bridge, scenarioEngine);
      return {
        bridge,
        clock: scenarioEngine.clock,
        disposal: scenarioEngine,
        installHandles: () => {
          bridgesWithHandles.add(bridge);
          return () => {
            bridgesWithHandles.delete(bridge);
          };
        },
      };
    },
    installSessionDiagnostics: () => () => undefined,
  };
}

describe("PlatformBridgeProvider — the resolved bridge's lifetime", () => {
  it("holds one engine across re-renders that change nothing it resolves on", () => {
    const composition = recordingComposition(CONCURRENT_STREAMING_SCENARIO_ID);
    const observed: PlatformBridge[] = [];
    const { rerender } = render(
      <PlatformBridgeProvider composition={composition}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </PlatformBridgeProvider>,
    );
    const first = lastBridge(observed);

    rerender(
      <PlatformBridgeProvider composition={composition}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </PlatformBridgeProvider>,
    );

    expect(observed.length).toBeGreaterThan(1);
    expect(lastBridge(observed)).toBe(first);
    expect(composition.engineOf(first).isDisposed).toBe(false);
  });

  it("replaces the engine when the composition changes, and disposes the one it replaced", () => {
    const concurrentStreamingComposition = recordingComposition(CONCURRENT_STREAMING_SCENARIO_ID);
    const firstRunComposition = recordingComposition(FIRST_RUN_SCENARIO_ID);
    const observed: PlatformBridge[] = [];
    const { rerender } = render(
      <PlatformBridgeProvider composition={concurrentStreamingComposition}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </PlatformBridgeProvider>,
    );
    const concurrentStreaming = concurrentStreamingComposition.engineOf(lastBridge(observed));

    rerender(
      <PlatformBridgeProvider composition={firstRunComposition}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </PlatformBridgeProvider>,
    );
    const firstRun = firstRunComposition.engineOf(lastBridge(observed));

    expect(firstRun).not.toBe(concurrentStreaming);
    expect(firstRun.scenario.id).toBe(FIRST_RUN_SCENARIO_ID);
    // The superseded engine is torn down, not just dropped: it still holds every subscribed sink,
    // and a driver holding the old handle would advance a scenario no window renders.
    expect(concurrentStreaming.isDisposed).toBe(true);
    expect(concurrentStreaming.sinkCount).toBe(0);
    expect(firstRun.isDisposed).toBe(false);
    // The replaced bridge's handles come down with it; the live one's go up.
    expect(concurrentStreamingComposition.bridgesWithHandles.size).toBe(0);
    expect([...firstRunComposition.bridgesWithHandles]).toEqual([lastBridge(observed)]);
  });

  it("disposes the engine it built when the console unmounts", () => {
    const composition = recordingComposition(CONCURRENT_STREAMING_SCENARIO_ID);
    const observed: PlatformBridge[] = [];
    const { unmount } = render(
      <PlatformBridgeProvider composition={composition}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </PlatformBridgeProvider>,
    );
    const engine = composition.engineOf(lastBridge(observed));
    expect(engine.isDisposed).toBe(false);

    unmount();

    expect(engine.isDisposed).toBe(true);
    expect(composition.bridgesWithHandles.size).toBe(0);
  });

  it("never disposes a bridge the caller supplied", () => {
    // Tests build a fixture once and render it through several providers; disposing on unmount
    // would tear down a resource this component never owned.
    const { bridge, scenarioEngine } = createFixtureBridge({
      scenario: CONCURRENT_STREAMING_SCENARIO,
    });
    const observed: PlatformBridge[] = [];
    const { unmount } = render(
      <PlatformBridgeProvider bridge={bridge} clock={scenarioEngine.clock}>
        <BridgeProbe onObserve={(seen) => observed.push(seen)} />
      </PlatformBridgeProvider>,
    );

    expect(lastBridge(observed)).toBe(bridge);
    unmount();

    expect(scenarioEngine.isDisposed).toBe(false);
  });

  it("re-mints after a double mount, so the console never holds a torn-down engine", () => {
    // StrictMode mounts, tears down and mounts again. The teardown disposes this provider's engine,
    // so the second mount must build a fresh one.
    const composition = recordingComposition(CONCURRENT_STREAMING_SCENARIO_ID);
    const observed: PlatformBridge[] = [];
    const tree: ReactNode = (
      <StrictMode>
        <PlatformBridgeProvider composition={composition}>
          <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
        </PlatformBridgeProvider>
      </StrictMode>
    );

    render(tree);

    const engine = composition.engineOf(lastBridge(observed));
    expect(engine.isDisposed).toBe(false);
    expect([...composition.bridgesWithHandles]).toEqual([lastBridge(observed)]);
  });
});

/** A component that does what any view does with time: read the clock. */
function ClockProbe(props: { readonly onObserve: (clock: Clock) => void }): null {
  props.onObserve(useClock());
  return null;
}

/**
 * The superseded form, kept as a control. `useState`'s lazy initializer runs once per mount,
 * which is the shape `useClock` had and the shape the case below fails on.
 */
function MountPinnedClockProbe(props: { readonly onObserve: (clock: Clock) => void }): null {
  const bridgeClock = useBridgeClock();
  const [clock] = useState<Clock>(() => bridgeClock);
  props.onObserve(clock);
  return null;
}

function lastClock(observed: readonly Clock[]): Clock {
  const clock = observed.at(-1);
  if (clock === undefined) {
    throw new Error("the probe never saw a clock");
  }
  return clock;
}

describe("useClock — the clock is a fact about the resolution", () => {
  const concurrentStreamingBridge = (): FixtureBridge =>
    createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
  const firstRunBridge = (): FixtureBridge =>
    createFixtureBridge({ scenario: findScenario(FIRST_RUN_SCENARIO_ID) });

  it("re-resolves on a bridge replacement, on the first committed render", () => {
    // The reading moves, not the identity: one `ForwardingClock` per mount keeps every `[clock]`
    // re-mint arm downstream from firing on a scenario switch, and it must stop reading the retired
    // bridge's time once the replacement commits.
    const bridgeA = concurrentStreamingBridge();
    const bridgeB = firstRunBridge();
    const observed: Clock[] = [];
    const { rerender } = render(
      <FixtureBridgeProvider fixture={bridgeA}>
        <ClockProbe onObserve={(clock) => observed.push(clock)} />
      </FixtureBridgeProvider>,
    );
    expect(lastClock(observed).now()).toBe(bridgeA.scenarioEngine.clock.now());

    bridgeB.scenarioEngine.tick();
    rerender(
      <FixtureBridgeProvider fixture={bridgeB}>
        <ClockProbe onObserve={(clock) => observed.push(clock)} />
      </FixtureBridgeProvider>,
    );

    expect(lastClock(observed).now()).toBe(bridgeB.scenarioEngine.clock.now());
    expect(lastClock(observed).now()).not.toBe(bridgeA.scenarioEngine.clock.now());
    // And it is still the same object every reader was handed at mount.
    expect(new Set(observed).size).toBe(1);
  });

  it("negative control: the mount-pinned form keeps the retired bridge's clock", () => {
    // The mount-pinned shape: everything downstream would keep reading a clock the scenario
    // switch stopped advancing.
    const bridgeA = concurrentStreamingBridge();
    const bridgeB = firstRunBridge();
    const observed: Clock[] = [];
    const { rerender } = render(
      <FixtureBridgeProvider fixture={bridgeA}>
        <MountPinnedClockProbe onObserve={(clock) => observed.push(clock)} />
      </FixtureBridgeProvider>,
    );
    rerender(
      <FixtureBridgeProvider fixture={bridgeB}>
        <MountPinnedClockProbe onObserve={(clock) => observed.push(clock)} />
      </FixtureBridgeProvider>,
    );

    expect(lastClock(observed)).toBe(bridgeA.scenarioEngine.clock);
    expect(lastClock(observed)).not.toBe(bridgeB.scenarioEngine.clock);
  });

  it("negative control: the two scenarios really do carry two clocks, and one bridge carries one", () => {
    // Without the first half the case above would pass over two bridges sharing a clock; without
    // the second, over a hook that recomputed on every render.
    const bridgeA = concurrentStreamingBridge();
    const bridgeB = firstRunBridge();
    expect(bridgeA.scenarioEngine.clock).not.toBe(bridgeB.scenarioEngine.clock);

    const observed: Clock[] = [];
    const { rerender } = render(
      <FixtureBridgeProvider fixture={bridgeA}>
        <ClockProbe onObserve={(clock) => observed.push(clock)} />
      </FixtureBridgeProvider>,
    );
    rerender(
      <FixtureBridgeProvider fixture={bridgeA}>
        <ClockProbe onObserve={(clock) => observed.push(clock)} />
      </FixtureBridgeProvider>,
    );
    expect(observed.length).toBeGreaterThan(1);
    expect(new Set(observed).size).toBe(1);
  });
});
