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
// an identity, and it can never dispose one.
//
// `ConsoleRoot` states the same rule one family up — "one store per window,
// created once; `useRef` rather than `useMemo`, because a memo may be discarded
// and recomputed and store identity is correctness" — and `frame/session-lifecycle.ts`
// is where the re-mint arm this file's last case drives comes from.

import { render } from "@testing-library/react";
import { StrictMode, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { type ConsoleClock } from "../core/index.js";
import {
  SidekicksBridgeProvider,
  useBridgeResolution,
  useConsoleBridge,
  useConsoleClock,
} from "./BridgeProvider.js";
import { consoleClockFor, type ConsoleBridge } from "./console-bridge.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import { consoleScenario } from "./scenario-manifest.js";
import { SCENARIO_FIXTURE_GLOBAL } from "./scenario-selection.js";
import { FIRST_RUN_SCENARIO_ID } from "./scenarios/first-run.js";
import { FLAGSHIP_SCENARIO, FLAGSHIP_SCENARIO_ID } from "./scenarios/flagship.js";

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

/** The page slot the provider hangs the scenario control on, read as a driver reads it. */
function scenarioControlIsInstalled(): boolean {
  return (globalThis as Record<string, unknown>)[SCENARIO_FIXTURE_GLOBAL] !== undefined;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[SCENARIO_FIXTURE_GLOBAL];
});

describe("SidekicksBridgeProvider — the resolved bridge's lifetime", () => {
  it("holds one engine across re-renders that change nothing it resolves on", () => {
    const observed: ConsoleBridge[] = [];
    const { rerender } = render(
      <SidekicksBridgeProvider scenarioId={FLAGSHIP_SCENARIO_ID}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </SidekicksBridgeProvider>,
    );
    const first = lastBridge(observed);

    rerender(
      <SidekicksBridgeProvider scenarioId={FLAGSHIP_SCENARIO_ID}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </SidekicksBridgeProvider>,
    );

    expect(observed.length).toBeGreaterThan(1);
    expect(lastBridge(observed)).toBe(first);
    expect(engineOf(first).isDisposed).toBe(false);
  });

  it("replaces the engine when the scenario changes, and disposes the one it replaced", () => {
    const observed: ConsoleBridge[] = [];
    const { rerender } = render(
      <SidekicksBridgeProvider scenarioId={FLAGSHIP_SCENARIO_ID}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </SidekicksBridgeProvider>,
    );
    const flagship = engineOf(lastBridge(observed));

    rerender(
      <SidekicksBridgeProvider scenarioId={FIRST_RUN_SCENARIO_ID}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </SidekicksBridgeProvider>,
    );
    const firstRun = engineOf(lastBridge(observed));

    expect(firstRun).not.toBe(flagship);
    expect(firstRun.scenario.id).toBe(FIRST_RUN_SCENARIO_ID);
    // The superseded engine is TORN DOWN rather than merely dropped. An
    // abandoned engine still holds every sink subscribed to it, and a driver
    // holding the old handle would go on advancing a scenario no window renders.
    expect(flagship.isDisposed).toBe(true);
    expect(flagship.sinkCount).toBe(0);
    expect(firstRun.isDisposed).toBe(false);
    expect(scenarioControlIsInstalled()).toBe(true);
  });

  it("disposes the engine it built when the console unmounts", () => {
    const observed: ConsoleBridge[] = [];
    const { unmount } = render(
      <SidekicksBridgeProvider scenarioId={FLAGSHIP_SCENARIO_ID}>
        <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
      </SidekicksBridgeProvider>,
    );
    const engine = engineOf(lastBridge(observed));
    expect(engine.isDisposed).toBe(false);

    unmount();

    expect(engine.isDisposed).toBe(true);
    expect(scenarioControlIsInstalled()).toBe(false);
  });

  it("never disposes a bridge the caller supplied", () => {
    // Tests and stories build a fixture once and render it through several
    // providers. Disposing one on unmount would tear down a resource this
    // component never owned, and the second render would be driving a corpse.
    const bridge = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
    const observed: ConsoleBridge[] = [];
    const { unmount } = render(
      <SidekicksBridgeProvider bridge={bridge}>
        <BridgeProbe onObserve={(seen) => observed.push(seen)} />
      </SidekicksBridgeProvider>,
    );

    expect(lastBridge(observed)).toBe(bridge);
    unmount();

    expect(engineOf(bridge).isDisposed).toBe(false);
  });

  it("re-mints after a double mount, so the console never holds a torn-down engine", () => {
    // React's StrictMode mounts, tears down, and mounts again. The teardown
    // disposes this provider's engine, so the second mount has to notice and
    // build a fresh one — the same re-mint arm `frame/session-lifecycle.ts`
    // carries for the registry and binder it owns.
    const observed: ConsoleBridge[] = [];
    const tree: ReactNode = (
      <StrictMode>
        <SidekicksBridgeProvider scenarioId={FLAGSHIP_SCENARIO_ID}>
          <BridgeProbe onObserve={(bridge) => observed.push(bridge)} />
        </SidekicksBridgeProvider>
      </StrictMode>
    );

    render(tree);

    const engine = engineOf(lastBridge(observed));
    expect(engine.isDisposed).toBe(false);
    expect(scenarioControlIsInstalled()).toBe(true);
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
  const flagshipBridge = (): ConsoleBridge => createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  const firstRunBridge = (): ConsoleBridge =>
    createFixtureBridge({ scenario: consoleScenario(FIRST_RUN_SCENARIO_ID) });

  it("re-resolves on a bridge replacement, on the first committed render", () => {
    const bridgeA = flagshipBridge();
    const bridgeB = firstRunBridge();
    const observed: ConsoleClock[] = [];
    const { rerender } = render(
      <SidekicksBridgeProvider bridge={bridgeA}>
        <ClockProbe onObserve={(clock) => observed.push(clock)} />
      </SidekicksBridgeProvider>,
    );
    expect(lastClock(observed)).toBe(engineOf(bridgeA).clock);

    rerender(
      <SidekicksBridgeProvider bridge={bridgeB}>
        <ClockProbe onObserve={(clock) => observed.push(clock)} />
      </SidekicksBridgeProvider>,
    );

    expect(lastClock(observed)).toBe(engineOf(bridgeB).clock);
  });

  it("negative control: the mount-pinned form keeps the retired bridge's clock", () => {
    // The shape this hook had. Everything downstream of it — the replay dock, the
    // reveal engine's armed frame, every `[clock]` re-mint arm — would go on
    // reading a clock the scenario switch stopped advancing.
    const bridgeA = flagshipBridge();
    const bridgeB = firstRunBridge();
    const observed: ConsoleClock[] = [];
    const { rerender } = render(
      <SidekicksBridgeProvider bridge={bridgeA}>
        <MountPinnedClockProbe onObserve={(clock) => observed.push(clock)} />
      </SidekicksBridgeProvider>,
    );
    rerender(
      <SidekicksBridgeProvider bridge={bridgeB}>
        <MountPinnedClockProbe onObserve={(clock) => observed.push(clock)} />
      </SidekicksBridgeProvider>,
    );

    expect(lastClock(observed)).toBe(engineOf(bridgeA).clock);
    expect(lastClock(observed)).not.toBe(engineOf(bridgeB).clock);
  });

  it("negative control: the two scenarios really do carry two clocks, and one bridge carries one", () => {
    // Without the first half the case above would pass over two bridges sharing a
    // clock; without the second, over a hook that recomputed on every render, which
    // is the property `useState` was there for and which must survive the change.
    const bridgeA = flagshipBridge();
    const bridgeB = firstRunBridge();
    expect(engineOf(bridgeA).clock).not.toBe(engineOf(bridgeB).clock);

    const observed: ConsoleClock[] = [];
    const { rerender } = render(
      <SidekicksBridgeProvider bridge={bridgeA}>
        <ClockProbe onObserve={(clock) => observed.push(clock)} />
      </SidekicksBridgeProvider>,
    );
    rerender(
      <SidekicksBridgeProvider bridge={bridgeA}>
        <ClockProbe onObserve={(clock) => observed.push(clock)} />
      </SidekicksBridgeProvider>,
    );
    expect(observed.length).toBeGreaterThan(1);
    expect(new Set(observed).size).toBe(1);
  });
});
