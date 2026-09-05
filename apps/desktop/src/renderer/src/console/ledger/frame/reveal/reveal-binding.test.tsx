// The reveal engine, mounted: one per feed, disposed with it, and its drain state
// reported rather than assumed.
//
// WHAT WAS BROKEN, and what each case below pins. `reveal-engine.ts` was constructed
// by nothing in production, no path handed a lane's text to a row, and the feed told
// the viewport `isRevealDraining: false` as a LITERAL — a default standing in for a
// reading, which `Spec-023 §Meridian, the design language` rule 8 refuses in the same
// words. Every case here would have passed against the old code only if the flag were
// a constant, which is why each carries the reading that a constant cannot produce.
//
// `ManualClock` is the instrument for the same reason `reveal-engine.test.ts` gives:
// the engine's frames are armed on it, so a disposal claim is `pendingCount` rather
// than an assertion about intent.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "../../../core/index.js";
import { TWO_FRAME_REVEAL_SOURCE } from "./reveal.test-support.js";
import { useLedgerReveal, type LedgerRevealBinding } from "./reveal-binding.js";

const LANE_ID = "session-1:41";

function mountBinding(
  clock: ManualClock,
): ReturnType<typeof renderHook<LedgerRevealBinding, void>> {
  return renderHook(() => useLedgerReveal({ clock }));
}

describe("the reveal binding — what the viewport is told", () => {
  it("reports the engine's drain state, which a settled feed reads as false", () => {
    const clock = new ManualClock();
    const binding = mountBinding(clock);
    expect(binding.result.current.isDraining).toBe(false);
    expect(clock.pendingCount).toBe(0);
  });

  it("reports draining from the delta that arms the frame until the lane settles", () => {
    // THE NEGATIVE CONTROL FOR THE LITERAL `false` the feed used to hand down: a
    // binding that reported a constant fails on the first expectation here, and one
    // that reported a constant `true` fails on the last.
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
    // Before the frame drains there is a lane and nothing revealed on it, which is
    // the whole point of the engine: text arrives in one act and appears over
    // several.
    expect(binding.result.current.channel.publishedTextFor(LANE_ID)).toBeUndefined();

    act(() => {
      clock.runFrame();
    });
    // ONE frame's worth, and the delta was twice that: what a row renders is the
    // engine's cursor into the source rather than the source itself.
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
  it("disposes the engine with the mount, cancelling the frame it had armed", () => {
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

    // A frame left armed on a disposed engine is a timer an unmounted feed is still
    // paying for, which is the idle-CPU budget's own precondition.
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
