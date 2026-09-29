// The clock a surface captures once still reads the window's current time.
//
// Split from `BridgeProvider.test.tsx` on the seam the provider draws: that file is
// about the RESOLUTION's lifetime — one engine held, replaced, disposed — and this one
// about what a component that captured a clock before the replacement now reads.
//
// THE DEFECT IN TERMS. `useClock` pinned `resolveBridgeClock(bridge)` in
// `useState`, and the provider replaces its resolution IN PLACE with no remount below
// it. So a scenario change handed the tree a new engine with a new frozen clock while
// `AppFrame`'s announcer went on stamping from the retired one — two time bases in one
// window, which is exactly what "the fixture clock is the only clock the renderer
// reads in fixture mode" forbids. It was invisible because both clocks answer.
//
// The two scenarios are the instrument: their engines start at different ticks, so
// which clock a reading came from is a number rather than an inference.

import { render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { PlatformBridgeProvider } from "../PlatformBridgeProvider.js";
import type { PlatformBridge } from "../platform-bridge.js";
import { createFixtureBridge } from "../platform-bridge.fixture.js";
import { findScenario } from "../../../../../../fixtures/index.js";
import { usePlatformBridge } from "./usePlatformBridge.js";
import { resolveBridgeClock, useClock } from "./useClock.js";
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
 * A surface that captures the hook's clock and, beside it, the window's own reading.
 *
 * Both in one component so the two are from the same render: comparing a clock
 * captured here against a reading taken outside would leave which render each came
 * from as something to reason about rather than something the probe fixes.
 */
function ClockProbe(props: ClockProbeProps): null {
  props.onClock(useClock());
  props.onWindowTime(resolveBridgeClock(usePlatformBridge()).now());
  return null;
}

/**
 * One bridge per scenario, built on first ask and handed back on every later one, so a
 * re-render that names the same scenario keeps the provider's resolution.
 */
function scenarioBridges(): (scenarioId: string) => PlatformBridge {
  const bridges = new Map<string, PlatformBridge>();
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
      <PlatformBridgeProvider bridge={bridgeFor(scenarioId)}>
        <ClockProbe
          onClock={(clock) => clocks.push(clock)}
          onWindowTime={(time) => windowTimes.push(time)}
        />
      </PlatformBridgeProvider>
    );
    const { rerender } = render(tree(CONCURRENT_STREAMING_SCENARIO_ID));
    const captured = lastOf(clocks, "a clock");
    const concurrentStreamingTime = lastOf(windowTimes, "a window time");

    rerender(tree(FIRST_RUN_SCENARIO_ID));
    const firstRunTime = lastOf(windowTimes, "a window time");

    // The two engines really are two time bases, or the rest of this proves nothing.
    expect(firstRunTime).not.toBe(concurrentStreamingTime);
    // ONE IDENTITY, so a consumer that pins the clock is not re-mounted by a scenario
    // change — and the reading behind that identity is the window's, not the retired
    // engine's.
    expect(lastOf(clocks, "a clock")).toBe(captured);
    expect(captured.now()).toBe(firstRunTime);
  });

  it("negative control: the pinned shape answers from the engine it was mounted on", () => {
    // The code this replaced, driven through the same provider: resolve once, hold it,
    // and the replacement is invisible. Kept only so the claim above is shown to
    // discriminate rather than to restate that both clocks answer.
    const pinnedTimes: number[] = [];
    const windowTimes: number[] = [];
    const bridgeFor = scenarioBridges();
    const tree = (scenarioId: string): React.JSX.Element => (
      <PlatformBridgeProvider bridge={bridgeFor(scenarioId)}>
        <PinnedClockProbe
          onPinnedTime={(time) => pinnedTimes.push(time)}
          onWindowTime={(time) => windowTimes.push(time)}
        />
      </PlatformBridgeProvider>
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

/** The shape `useClock` replaced: resolve once into `useState`, then hold it. */
function PinnedClockProbe(props: PinnedClockProbeProps): null {
  const bridge = usePlatformBridge();
  const [pinned] = useState<Clock>(() => resolveBridgeClock(bridge));
  props.onPinnedTime(pinned.now());
  props.onWindowTime(resolveBridgeClock(bridge).now());
  return null;
}
