import { describe, expect, test } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { AnimationFrameScheduler } from "@renderer/features/transcript/animation-frame-scheduler.js";
import { type ScrollGeometry } from "./geometry-sample.js";
import { type ScrollCaller } from "./scroll-callers.js";
import { ScrollFrameWrites } from "./scroll-frame-writes.js";

const geometryAt = (scrollTop: number): ScrollGeometry => ({
  scrollTop,
  viewportHeight: 400,
  contentHeight: 2000,
  distanceFromTailPx: 1600 - scrollTop,
  isAtTail: false,
  sampledAt: 0,
  cause: "scroll",
});

interface RecordedWrite {
  readonly caller: ScrollCaller;
  readonly targetScrollTop: number;
}

const constructQueue = (): {
  clock: ManualClock;
  scheduler: AnimationFrameScheduler;
  frameWrites: ScrollFrameWrites;
  writes: RecordedWrite[];
  setGeometry: (geometry: ScrollGeometry | undefined) => void;
} => {
  const clock = new ManualClock();
  const scheduler = new AnimationFrameScheduler({ clock });
  const writes: RecordedWrite[] = [];
  let lastGeometry: ScrollGeometry | undefined = geometryAt(100);
  const frameWrites = new ScrollFrameWrites({
    get lastGeometry(): ScrollGeometry | undefined {
      return lastGeometry;
    },
    glide: (caller, targetScrollTop) => {
      writes.push({ caller, targetScrollTop });
    },
  });
  return {
    clock,
    scheduler,
    frameWrites,
    writes,
    setGeometry: (geometry) => {
      lastGeometry = geometry;
    },
  };
};

describe("ScrollFrameWrites", () => {
  test("refuses a request until a frame has been adopted", () => {
    const { clock, frameWrites, writes } = constructQueue();

    expect(frameWrites.request("follow-tail", () => 900)).toBe(false);

    clock.runFrame();
    // An immediate fallback write would land here, unordered.
    expect(writes).toEqual([]);
  });

  test("performs the write in phase one of the next frame", () => {
    const { clock, scheduler, frameWrites, writes } = constructQueue();
    frameWrites.adopt(scheduler);

    expect(frameWrites.request("follow-tail", (geometry) => geometry.contentHeight - 100)).toBe(
      true,
    );
    expect(writes).toEqual([]);

    clock.runFrame();

    expect(writes).toEqual([{ caller: "follow-tail", targetScrollTop: 1900 }]);
  });

  test("coalesces per caller and keeps the last computation", () => {
    const { clock, scheduler, frameWrites, writes } = constructQueue();
    frameWrites.adopt(scheduler);

    frameWrites.request("follow-tail", () => 500);
    frameWrites.request("follow-tail", () => 700);

    clock.runFrame();

    expect(writes).toEqual([{ caller: "follow-tail", targetScrollTop: 700 }]);
  });

  test("two callers both get their turn, in submission order", () => {
    const { clock, scheduler, frameWrites, writes } = constructQueue();
    frameWrites.adopt(scheduler);

    frameWrites.request("hold-reading-position", () => 300);
    frameWrites.request("prune-compensation", () => 320);

    clock.runFrame();

    expect(writes).toEqual([
      { caller: "hold-reading-position", targetScrollTop: 300 },
      { caller: "prune-compensation", targetScrollTop: 320 },
    ]);
  });

  test("adopting the same scheduler twice is a no-op and a second one throws", () => {
    const { clock, scheduler, frameWrites } = constructQueue();
    frameWrites.adopt(scheduler);

    expect(() => {
      frameWrites.adopt(scheduler);
    }).not.toThrow();
    expect(() => {
      frameWrites.adopt(new AnimationFrameScheduler({ clock }));
    }).toThrow(/one controller writes inside one frame/);
  });

  test("release cancels the submitted task, so a torn-down controller writes nothing", () => {
    const { clock, scheduler, frameWrites, writes } = constructQueue();
    frameWrites.adopt(scheduler);

    frameWrites.request("follow-tail", () => 900);
    frameWrites.release();
    clock.runFrame();

    expect(writes).toEqual([]);
    expect(scheduler.pendingTaskCount).toBe(0);
    expect(frameWrites.request("follow-tail", () => 900)).toBe(false);
  });
});
