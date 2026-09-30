// The clock a component captures once still reads the window's current time. The provider replaces
// its resolution in place with no remount, so a clock pinned in `useState` would keep the retired
// engine's time base, invisible because both clocks answer. The two scenarios' engines start at
// different ticks, so which clock a reading came from is a number, not an inference.
// `PlatformBridgeProvider.test.tsx` covers the resolution's lifetime.

import { render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { createFixtureBridge, type FixtureBridge } from "../platform-bridge.fixture.js";
import { findScenario } from "../../../../../../fixtures/index.js";
import { useBridgeClock, useClock } from "./useClock.js";
import type { Clock } from "@renderer/lib/clock.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../../../../fixtures/scenarios/first-run.js";
import { CONCURRENT_STREAMING_SCENARIO_ID } from "../../../../../../fixtures/scenarios/concurrent-streaming.js";

interface ClockProbeProps {
  /** Every clock a render was handed, so its identity across renders is readable. */
  readonly onClock: (clock: Clock) => void;
  /** What the window's own resolution says the time is, for the same render. */
  readonly onWindowTime: (time: number) => void;
}

/**
 * A component that captures the hook's clock and, beside it, the window's own reading, in one
 * render so the two are comparable.
 */
function ClockProbe(props: ClockProbeProps): null {
  props.onClock(useClock());
  props.onWindowTime(useBridgeClock().now());
  return null;
}

/**
 * One bridge per scenario, built on first ask and handed back on every later one, so a
 * re-render that names the same scenario keeps the provider's resolution.
 */
function scenarioBridges(): (scenarioId: string) => FixtureBridge {
  const bridges = new Map<string, FixtureBridge>();
  return (scenarioId) => {
    const existing = bridges.get(scenarioId);
    if (existing !== undefined) {
      return existing;
    }
    const bridge = createFixtureBridge({ scenario: findScenario(scenarioId) });
    bridges.set(scenarioId, bridge);
    return bridge;
  };
}

function lastOf<TSeen>(seen: readonly TSeen[], what: string): TSeen {
  const value = seen.at(-1);
  if (value === undefined) {
    throw new Error(`the probe never observed ${what}`);
  }
  return value;
}

describe("useClock — one identity, and the window's current reading", () => {
  it("reads the replacement's clock through the identity it handed out first", () => {
    const clocks: Clock[] = [];
    const windowTimes: number[] = [];
    const bridgeFor = scenarioBridges();
    const tree = (scenarioId: string): React.JSX.Element => (
      <FixtureBridgeProvider fixture={bridgeFor(scenarioId)}>
        <ClockProbe
          onClock={(clock) => clocks.push(clock)}
          onWindowTime={(time) => windowTimes.push(time)}
        />
      </FixtureBridgeProvider>
    );
    const { rerender } = render(tree(CONCURRENT_STREAMING_SCENARIO_ID));
    const captured = lastOf(clocks, "a clock");
    const concurrentStreamingTime = lastOf(windowTimes, "a window time");

    rerender(tree(FIRST_RUN_SCENARIO_ID));
    const firstRunTime = lastOf(windowTimes, "a window time");

    // The two engines really are two time bases, or the rest of this proves nothing.
    expect(firstRunTime).not.toBe(concurrentStreamingTime);
    // One identity, so a consumer that pins the clock is not re-mounted by a scenario change, and
    // the reading behind it is the window's, not the retired engine's.
    expect(lastOf(clocks, "a clock")).toBe(captured);
    expect(captured.now()).toBe(firstRunTime);
  });

  it("negative control: the pinned shape answers from the engine it was mounted on", () => {
    // The mount-pinned form through the same provider: the replacement is invisible to it, which
    // shows the claim above discriminates.
    const pinnedTimes: number[] = [];
    const windowTimes: number[] = [];
    const bridgeFor = scenarioBridges();
    const tree = (scenarioId: string): React.JSX.Element => (
      <FixtureBridgeProvider fixture={bridgeFor(scenarioId)}>
        <PinnedClockProbe
          onPinnedTime={(time) => pinnedTimes.push(time)}
          onWindowTime={(time) => windowTimes.push(time)}
        />
      </FixtureBridgeProvider>
    );
    const { rerender } = render(tree(CONCURRENT_STREAMING_SCENARIO_ID));
    const concurrentStreamingTime = lastOf(windowTimes, "a window time");

    rerender(tree(FIRST_RUN_SCENARIO_ID));

    expect(lastOf(windowTimes, "a window time")).not.toBe(concurrentStreamingTime);
    expect(lastOf(pinnedTimes, "a pinned time")).toBe(concurrentStreamingTime);
  });
});

interface PinnedClockProbeProps {
  readonly onPinnedTime: (time: number) => void;
  readonly onWindowTime: (time: number) => void;
}

/** The mount-pinned form, kept as a control: resolve once into `useState`, then hold it. */
function PinnedClockProbe(props: PinnedClockProbeProps): null {
  const bridgeClock = useBridgeClock();
  const [pinned] = useState<Clock>(() => bridgeClock);
  props.onPinnedTime(pinned.now());
  props.onWindowTime(bridgeClock.now());
  return null;
}
