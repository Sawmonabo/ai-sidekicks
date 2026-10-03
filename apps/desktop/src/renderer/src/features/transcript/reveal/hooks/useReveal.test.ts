// The reveal engine mounted: one per feed, disposed with it, and its drain state reported rather
// than assumed. Each case carries a reading a constant `isDraining` cannot produce. `ManualClock`
// is the instrument because a disposal claim is `pendingCount`, not an assertion about intent.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { TWO_FRAME_REVEAL_SOURCE } from "../reveal.test-support.js";
import { useAnimationFrameScheduler } from "../../hooks/useAnimationFrameScheduler.js";
import { useReveal, type RevealBinding } from "./useReveal.js";

const LANE_ID = "session-1:41";

function mountBinding(clock: ManualClock): ReturnType<typeof renderHook<RevealBinding, void>> {
  return renderHook(() => useReveal({ frameScheduler: useAnimationFrameScheduler(clock), clock }));
}

describe("the reveal binding — what the viewport is told", () => {
  it("reports draining from the delta that arms the frame until the lane settles", () => {
    // Negative control for a constant `false`: a binding that reported a constant fails the first
    // expectation, and a constant `true` fails the last.
    const clock = new ManualClock();
    const binding = mountBinding(clock);

    act(() => {
      binding.result.current.ingest({
        laneId: LANE_ID,
        mode: "direct",
        text: TWO_FRAME_REVEAL_SOURCE,
      });
    });
    expect(binding.result.current.isDraining).toBe(true);
    expect(clock.pendingFrameCount).toBe(1);

    // Two lanes' worth of text takes more than one frame, which is what makes the
    // flag a state and not an edge: it stays true across the frames still owed.
    act(() => {
      clock.runFrame();
    });
    expect(binding.result.current.isDraining).toBe(true);

    act(() => {
      while (clock.pendingFrameCount > 0) {
        clock.runFrame();
      }
    });
    expect(binding.result.current.isDraining).toBe(false);
    expect(clock.pendingCount).toBe(0);
  });
});

describe("the reveal binding — what a row is published", () => {
  it("retires the lanes a predicate names, and leaves the others publishing", () => {
    const clock = new ManualClock();
    const binding = mountBinding(clock);
    const otherLaneId = "session-1:42";

    act(() => {
      binding.result.current.ingest({
        laneId: LANE_ID,
        mode: "direct",
        text: TWO_FRAME_REVEAL_SOURCE,
      });
      binding.result.current.ingest({
        laneId: otherLaneId,
        mode: "direct",
        text: TWO_FRAME_REVEAL_SOURCE,
      });
      clock.runFrame();
    });
    expect(binding.result.current.channel.publishedTextFor(LANE_ID)).toBeDefined();

    act(() => {
      binding.result.current.retireLanes((laneId) => laneId === LANE_ID);
    });
    expect(binding.result.current.channel.publishedTextFor(LANE_ID)).toBeUndefined();
    expect(binding.result.current.channel.publishedTextFor(otherLaneId)).toBeDefined();
  });
});

describe("the reveal binding — teardown", () => {
  it("disposes the engine with the mount, canceling the frame it had armed", () => {
    const clock = new ManualClock();
    const binding = mountBinding(clock);
    act(() => {
      binding.result.current.ingest({
        laneId: LANE_ID,
        mode: "direct",
        text: TWO_FRAME_REVEAL_SOURCE,
      });
    });
    expect(clock.pendingFrameCount).toBe(1);

    binding.unmount();

    // A frame left armed on a disposed engine is a timer an unmounted feed still pays for.
    expect(clock.pendingCount).toBe(0);
  });
});
