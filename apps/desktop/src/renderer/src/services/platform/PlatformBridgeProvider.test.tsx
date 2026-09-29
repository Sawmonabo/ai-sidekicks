// The resolved bridge is a resource with a lifetime, not a cached computation.
//
// The provider used to hold its resolution in a `useMemo`. React documents that
// cache as a performance hint it may discard and recompute, and the fixture arm
// puts a MUTABLE `ScenarioEngine` inside it: a discarded cache starts a second
// engine at tick zero while the first one — with its subscriptions, its frozen
// clock, and every beat it had delivered — is abandoned mid-scenario. The same
// gap left the replacement path silent: changing the scenario built a new engine
// and disposed nothing, so the old one stayed subscribable forever.
//
// So the cases here are about IDENTITY and about TEARDOWN, and the two that fail
// the way the regression did are the replacement and the unmount: a memo can keep
// an identity, and it can never dispose one. The composition is a recording one built
// here rather than the fixture launch's, so what is asserted is the provider's contract
// with any composition: build once, install once, take both down.
//
// `ConsoleRoot` states the same rule one family up — "one store per window,
// created once; `useRef` rather than `useMemo`, because a memo may be discarded
// and recomputed and store identity is correctness" — and `app/hooks/useSessionStoreRegistry.ts`
// is where the re-mint arm this file's last case drives comes from.

import { render } from "@testing-library/react";
import { StrictMode, useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { type ConsoleClock } from "@renderer/lib/clock.js";
import { DesktopBridgeProvider } from "./PlatformBridgeProvider.js";
import { useBridgeResolution } from "./hooks/useBridgeResolution.js";
import { useConsoleBridge } from "./hooks/usePlatformBridge.js";
import { consoleClockFor, useConsoleClock } from "./hooks/useClock.js";
import { type BridgeComposition } from "./bridge-context.js";
import { type ConsoleBridge } from "./platform-bridge.js";
import { createFixtureBridge } from "./platform-bridge.fixture.js";
import { findScenario } from "../../../../../fixtures/index.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../../../fixtures/scenarios/first-run.js";
import {
  FLAGSHIP_SCENARIO,
  CONCURRENT_STREAMING_SCENARIO_ID,
} from "../../../../../fixtures/scenarios/concurrent-streaming.js";

interface BridgeProbeProps {
  readonly onObserve: (bridge: ConsoleBridge) => void;
}

/** A component that does exactly what a console surface does: read the bridge. */
function BridgeProbe(props: BridgeProbeProps): null {
  const resolution = useBridgeResolution();
  if (resolution.status === "ready") {
    props.onObserve(resolution.bridge);
  }
  return null;
}

function lastBridge(observed: readonly ConsoleBridge[]): ConsoleBridge {
  const bridge = observed.at(-1);
  if (bridge === undefined) {
    throw new Error("the probe never saw a resolved bridge");
  }
  return bridge;
}

function engineOf(bridge: ConsoleBridge): NonNullable<ConsoleBridge["scenarioEngine"]> {
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the resolved bridge carries no scenario engine, so there is nothing to hold");
  }
  return engine;
}

/** A composition that plays one scenario and records which of its bridges hold handles. */
interface RecordingComposition extends BridgeComposition {
  readonly bridgesWithHandles: ReadonlySet<ConsoleBridge>;
}

function recordingComposition(scenarioId: string): RecordingComposition {
  const scenario = findScenario(scenarioId);
  const bridgesWithHandles = new Set<ConsoleBridge>();
  return {
    bridgesWithHandles,
    createBridge: () => createFixtureBridge({ scenario }),
    installBridgeHandles: (bridge) => {
      bridgesWithHandles.add(bridge);
      return () => {
        bridgesWithHandles.delete(bridge);
      };
    },
    installSessionDiagnostics: () => () => undefined,
  };
}

describe("DesktopBridgeProvider — the resolved bridge's lifetime", () => {
  it("holds one engine across re-renders that change nothing it resolves on", () => {
    const composition = recordingComposition(CONCURRENT_STREAMING_SCENARIO_ID);
    const observed: ConsoleBridge[] = [];
    const { rerender } = render(
      <DesktopBridgeProvider composition={composition}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </DesktopBridgeProvider>,
    );
    const first = lastBridge(observed);

    rerender(
      <DesktopBridgeProvider composition={composition}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </DesktopBridgeProvider>,
    );

    expect(observed.length).toBeGreaterThan(1);
    expect(lastBridge(observed)).toBe(first);
    expect(engineOf(first).isDisposed).toBe(false);
  });

  it("replaces the engine when the composition changes, and disposes the one it replaced", () => {
    const concurrentStreamingComposition = recordingComposition(CONCURRENT_STREAMING_SCENARIO_ID);
    const firstRunComposition = recordingComposition(FIRST_RUN_SCENARIO_ID);
    const observed: ConsoleBridge[] = [];
    const { rerender } = render(
      <DesktopBridgeProvider composition={concurrentStreamingComposition}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </DesktopBridgeProvider>,
    );
    const concurrentStreaming = engineOf(lastBridge(observed));

    rerender(
      <DesktopBridgeProvider composition={firstRunComposition}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </DesktopBridgeProvider>,
    );
    const firstRun = engineOf(lastBridge(observed));

    expect(firstRun).not.toBe(concurrentStreaming);
    expect(firstRun.scenario.id).toBe(FIRST_RUN_SCENARIO_ID);
    // The superseded engine is TORN DOWN rather than merely dropped. An
    // abandoned engine still holds every sink subscribed to it, and a driver
    // holding the old handle would go on advancing a scenario no window renders.
    expect(concurrentStreaming.isDisposed).toBe(true);
    expect(concurrentStreaming.sinkCount).toBe(0);
    expect(firstRun.isDisposed).toBe(false);
    // The replaced bridge's handles come down with it; the live one's go up.
    expect(concurrentStreamingComposition.bridgesWithHandles.size).toBe(0);
    expect([...firstRunComposition.bridgesWithHandles]).toEqual([lastBridge(observed)]);
  });

  it("disposes the engine it built when the console unmounts", () => {
    const composition = recordingComposition(CONCURRENT_STREAMING_SCENARIO_ID);
    const observed: ConsoleBridge[] = [];
    const { unmount } = render(
      <DesktopBridgeProvider composition={composition}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </DesktopBridgeProvider>,
    );
    const engine = engineOf(lastBridge(observed));
    expect(engine.isDisposed).toBe(false);

    unmount();

    expect(engine.isDisposed).toBe(true);
    expect(composition.bridgesWithHandles.size).toBe(0);
  });

  it("never disposes a bridge the caller supplied", () => {
    // Tests and stories build a fixture once and render it through several
    // providers. Disposing one on unmount would tear down a resource this
    // component never owned, and the second render would be driving a corpse.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const observed: ConsoleBridge[] = [];
    const { unmount } = render(
      <DesktopBridgeProvider bridge={bridge}>
        <BridgeProbe onObserve={(seen) => observed.push(seen)} />
      </DesktopBridgeProvider>,
    );

    expect(lastBridge(observed)).toBe(bridge);
    unmount();

    expect(engineOf(bridge).isDisposed).toBe(false);
  });

  it("re-mints after a double mount, so the console never holds a torn-down engine", () => {
    // React's StrictMode mounts, tears down, and mounts again. The teardown
    // disposes this provider's engine, so the second mount has to notice and
    // build a fresh one — the same re-mint arm `app/hooks/useSessionStoreRegistry.ts`
    // carries for the registry and binder it owns.
    const composition = recordingComposition(CONCURRENT_STREAMING_SCENARIO_ID);
    const observed: ConsoleBridge[] = [];
    const tree: ReactNode = (
      <StrictMode>
        <DesktopBridgeProvider composition={composition}>
          <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
        </DesktopBridgeProvider>
      </StrictMode>
    );

    render(tree);

    const engine = engineOf(lastBridge(observed));
    expect(engine.isDisposed).toBe(false);
    expect([...composition.bridgesWithHandles]).toEqual([lastBridge(observed)]);
  });
});

/** A component that does what a console surface does with time: read the clock. */
function ClockProbe(props: { readonly onObserve: (clock: ConsoleClock) => void }): null {
  props.onObserve(useConsoleClock());
  return null;
}

/**
 * The superseded form, kept as a control rather than as an alternative.
 *
 * `useState`'s lazy initializer runs once for the life of the MOUNT, which is the
 * shape `useConsoleClock` had and the shape the case below fails on. It is written
 * here so the replacement's claim is measured against the thing it replaced instead
 * of being asserted.
 */
function MountPinnedClockProbe(props: { readonly onObserve: (clock: ConsoleClock) => void }): null {
  const bridge = useConsoleBridge();
  const [clock] = useState<ConsoleClock>(() => consoleClockFor(bridge));
  props.onObserve(clock);
  return null;
}

function lastClock(observed: readonly ConsoleClock[]): ConsoleClock {
  const clock = observed.at(-1);
  if (clock === undefined) {
    throw new Error("the probe never saw a clock");
  }
  return clock;
}

describe("useConsoleClock — the clock is a fact about the bridge", () => {
  const concurrentStreamingBridge = (): ConsoleBridge =>
    createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  const firstRunBridge = (): ConsoleBridge =>
    createFixtureBridge({ scenario: findScenario(FIRST_RUN_SCENARIO_ID) });

  it("re-resolves on a bridge replacement, on the first committed render", () => {
    // The READING is what moves, not the identity. One `ForwardingConsoleClock` per
    // mount is the whole point — every `[clock]` re-mint arm downstream would fire on
    // a scenario switch if the hook handed back a new object — so what the case has
    // to show is that the one object it does hand back stops reading the retired
    // bridge's time the moment the replacement is committed.
    const bridgeA = concurrentStreamingBridge();
    const bridgeB = firstRunBridge();
    const observed: ConsoleClock[] = [];
    const { rerender } = render(
      <DesktopBridgeProvider bridge={bridgeA}>
        <ClockProbe onObserve={(clock) => observed.push(clock)} />
      </DesktopBridgeProvider>,
    );
    expect(lastClock(observed).now()).toBe(engineOf(bridgeA).clock.now());

    engineOf(bridgeB).tick();
    rerender(
      <DesktopBridgeProvider bridge={bridgeB}>
        <ClockProbe onObserve={(clock) => observed.push(clock)} />
      </DesktopBridgeProvider>,
    );

    expect(lastClock(observed).now()).toBe(engineOf(bridgeB).clock.now());
    expect(lastClock(observed).now()).not.toBe(engineOf(bridgeA).clock.now());
    // And it is still the same object every reader was handed at mount.
    expect(new Set(observed).size).toBe(1);
  });

  it("negative control: the mount-pinned form keeps the retired bridge's clock", () => {
    // The shape this hook had. Everything downstream of it — the deck's rect flush,
    // the reveal engine's armed frame, every `[clock]` re-mint arm — would go on
    // reading a clock the scenario switch stopped advancing.
    const bridgeA = concurrentStreamingBridge();
    const bridgeB = firstRunBridge();
    const observed: ConsoleClock[] = [];
    const { rerender } = render(
      <DesktopBridgeProvider bridge={bridgeA}>
        <MountPinnedClockProbe onObserve={(clock) => observed.push(clock)} />
      </DesktopBridgeProvider>,
    );
    rerender(
      <DesktopBridgeProvider bridge={bridgeB}>
        <MountPinnedClockProbe onObserve={(clock) => observed.push(clock)} />
      </DesktopBridgeProvider>,
    );

    expect(lastClock(observed)).toBe(engineOf(bridgeA).clock);
    expect(lastClock(observed)).not.toBe(engineOf(bridgeB).clock);
  });

  it("negative control: the two scenarios really do carry two clocks, and one bridge carries one", () => {
    // Without the first half the case above would pass over two bridges sharing a
    // clock; without the second, over a hook that recomputed on every render, which
    // is the property `useState` was there for and which must survive the change.
    const bridgeA = concurrentStreamingBridge();
    const bridgeB = firstRunBridge();
    expect(engineOf(bridgeA).clock).not.toBe(engineOf(bridgeB).clock);

    const observed: ConsoleClock[] = [];
    const { rerender } = render(
      <DesktopBridgeProvider bridge={bridgeA}>
        <ClockProbe onObserve={(clock) => observed.push(clock)} />
      </DesktopBridgeProvider>,
    );
    rerender(
      <DesktopBridgeProvider bridge={bridgeA}>
        <ClockProbe onObserve={(clock) => observed.push(clock)} />
      </DesktopBridgeProvider>,
    );
    expect(observed.length).toBeGreaterThan(1);
    expect(new Set(observed).size).toBe(1);
  });
});
