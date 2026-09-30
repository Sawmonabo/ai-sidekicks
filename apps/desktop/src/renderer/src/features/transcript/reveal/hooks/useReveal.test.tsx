// The reveal engine mounted: one per feed, disposed with it, and its drain state reported rather
// than assumed. Each case carries a reading a constant `isDraining` cannot produce. `ManualClock`
// is the instrument because a disposal claim is `pendingCount`, not an assertion about intent.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { TWO_FRAME_REVEAL_SOURCE } from "../reveal.test-support.js";
import { useAnimationFrameCoordinator } from "../../hooks/useAnimationFrameCoordinator.js";
import { useReveal, type RevealBinding } from "./useReveal.js";

const LANE_ID = "session-1:41";

function mountBinding(clock: ManualClock): ReturnType<typeof renderHook<RevealBinding, void>> {
  return renderHook(() => useReveal({ frameCoordinator: useAnimationFrameCoordinator(clock) }));
}

describe("the reveal binding — what the viewport is told", () => {
  it("reports the engine's drain state, which a settled feed reads as false", () => {
    const clock = new ManualClock();
    const binding = mountBinding(clock);
    expect(binding.result.current.isDraining).toBe(false);
    expect(clock.pendingCount).toBe(0);
  });

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
  it("publishes the engine's revealed text, and never the raw delta", () => {
    const clock = new ManualClock();
    const binding = mountBinding(clock);

    act(() => {
      binding.result.current.ingest({
        laneId: LANE_ID,
        mode: "direct",
        text: TWO_FRAME_REVEAL_SOURCE,
      });
    });
    // Before the frame drains there is a lane with nothing revealed on it: text arrives in one
    // act and appears over several.
    expect(binding.result.current.channel.publishedTextFor(LANE_ID)).toBeUndefined();

    act(() => {
      clock.runFrame();
    });
    // One frame's worth of a delta twice that: a row renders the engine's cursor, not the source.
    const published = binding.result.current.channel.publishedTextFor(LANE_ID);
    expect(published).toBeDefined();
    expect(published?.length).toBeLessThan(TWO_FRAME_REVEAL_SOURCE.length);
    expect(TWO_FRAME_REVEAL_SOURCE.startsWith(published ?? "")).toBe(true);
    // And a lane the engine has never seen publishes nothing rather than whatever
    // was last ingested anywhere.
    expect(binding.result.current.channel.publishedTextFor("a-lane-nobody-opened")).toBeUndefined();
  });

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

  it("negative control: a live mount keeps the frame it armed", () => {
    // Without this the case above would pass over a binding that armed nothing at
    // all — which is what a feed with no engine in it does.
    const clock = new ManualClock();
    const binding = mountBinding(clock);
    act(() => {
      binding.result.current.ingest({
        laneId: LANE_ID,
        mode: "direct",
        text: TWO_FRAME_REVEAL_SOURCE,
      });
    });
    expect(clock.pendingCount).toBe(1);
  });
});
