// The clock a surface captures once still reads the window's current time.
//
// Split from `BridgeProvider.test.tsx` on the seam the provider draws: that file is
// about the RESOLUTION's lifetime — one engine held, replaced, disposed — and this one
// about what a component that captured a clock before the replacement now reads.
//
// THE DEFECT IN TERMS. `useConsoleClock` pinned `consoleClockFor(bridge)` in
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

import { SidekicksBridgeProvider, useConsoleBridge, useConsoleClock } from "./BridgeProvider.js";
import { consoleClockFor } from "./console-bridge.js";
import type { ConsoleClock } from "../core/index.js";
import { FIRST_RUN_SCENARIO_ID } from "./scenarios/first-run.js";
import { FLAGSHIP_SCENARIO_ID } from "./scenarios/flagship.js";

interface ClockProbeProps {
  /** Every clock a render was handed, so its identity across renders is readable. */
  readonly onClock: (clock: ConsoleClock) => void;
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
  props.onClock(useConsoleClock());
  props.onWindowTime(consoleClockFor(useConsoleBridge()).now());
  return null;
}

function lastOf<TSeen>(seen: readonly TSeen[], what: string): TSeen {
  const value = seen.at(-1);
  if (value === undefined) {
    throw new Error(`the probe never observed ${what}`);
  }
  return value;
}

describe("useConsoleClock — one identity, and the window's current reading", () => {
  it("reads the replacement's clock through the identity it handed out first", () => {
    const clocks: ConsoleClock[] = [];
    const windowTimes: number[] = [];
    const tree = (scenarioId: string): React.JSX.Element => (
      <SidekicksBridgeProvider scenarioId={scenarioId}>
        <ClockProbe
          onClock={(clock) => clocks.push(clock)}
          onWindowTime={(time) => windowTimes.push(time)}
        />
      </SidekicksBridgeProvider>
    );
    const { rerender } = render(tree(FLAGSHIP_SCENARIO_ID));
    const captured = lastOf(clocks, "a clock");
    const flagshipTime = lastOf(windowTimes, "a window time");

    rerender(tree(FIRST_RUN_SCENARIO_ID));
    const firstRunTime = lastOf(windowTimes, "a window time");

    // The two engines really are two time bases, or the rest of this proves nothing.
    expect(firstRunTime).not.toBe(flagshipTime);
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
    const tree = (scenarioId: string): React.JSX.Element => (
      <SidekicksBridgeProvider scenarioId={scenarioId}>
        <PinnedClockProbe
          onPinnedTime={(time) => pinnedTimes.push(time)}
          onWindowTime={(time) => windowTimes.push(time)}
        />
      </SidekicksBridgeProvider>
    );
    const { rerender } = render(tree(FLAGSHIP_SCENARIO_ID));
    const flagshipTime = lastOf(windowTimes, "a window time");

    rerender(tree(FIRST_RUN_SCENARIO_ID));

    expect(lastOf(windowTimes, "a window time")).not.toBe(flagshipTime);
    expect(lastOf(pinnedTimes, "a pinned time")).toBe(flagshipTime);
  });
});

interface PinnedClockProbeProps {
  readonly onPinnedTime: (time: number) => void;
  readonly onWindowTime: (time: number) => void;
}

/** The shape `useConsoleClock` replaced: resolve once into `useState`, then hold it. */
function PinnedClockProbe(props: PinnedClockProbeProps): null {
  const bridge = useConsoleBridge();
  const [pinned] = useState<ConsoleClock>(() => consoleClockFor(bridge));
  props.onPinnedTime(pinned.now());
  props.onWindowTime(consoleClockFor(bridge).now());
  return null;
}
