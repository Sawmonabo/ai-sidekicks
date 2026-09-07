import { describe, expect, test } from "vitest";

import { ManualClock } from "../../../core/index.js";
import { LedgerFrameCoordinator } from "../coordinator/frame-coordinator.js";
import { type LedgerGeometry } from "../measurement/index.js";
import { type LedgerScrollCaller } from "./scroll-callers.js";
import { LedgerScrollFrameWrites } from "./scroll-frame-writes.js";

const geometryAt = (scrollTop: number): LedgerGeometry => ({
  scrollTop,
  viewportHeight: 400,
  contentHeight: 2000,
  distanceFromTailPx: 1600 - scrollTop,
  isAtTail: false,
  sampledAt: 0,
  cause: "scroll",
});

interface RecordedWrite {
  readonly caller: LedgerScrollCaller;
  readonly targetScrollTop: number;
}

const constructQueue = (): {
  clock: ManualClock;
  coordinator: LedgerFrameCoordinator;
  frameWrites: LedgerScrollFrameWrites;
  writes: RecordedWrite[];
  setGeometry: (geometry: LedgerGeometry | undefined) => void;
} => {
  const clock = new ManualClock();
  const coordinator = new LedgerFrameCoordinator({ clock });
  const writes: RecordedWrite[] = [];
  let lastGeometry: LedgerGeometry | undefined = geometryAt(100);
  const frameWrites = new LedgerScrollFrameWrites({
    get lastGeometry(): LedgerGeometry | undefined {
      return lastGeometry;
    },
    glide: (caller, targetScrollTop) => {
      writes.push({ caller, targetScrollTop });
    },
  });
  return {
    clock,
    coordinator,
    frameWrites,
    writes,
    setGeometry: (geometry) => {
      lastGeometry = geometry;
    },
  };
};

describe("LedgerScrollFrameWrites", () => {
  test("refuses a request until a frame has been adopted", () => {
    const { clock, frameWrites, writes } = constructQueue();

    expect(frameWrites.hasFrame).toBe(false);
    expect(frameWrites.request("follow-tail", () => 900)).toBe(false);

    clock.runFrame();
    // The negative control for the fail-closed rule: an immediate fallback write
    // would land here, unordered, exactly as it did before there was a frame.
    expect(writes).toEqual([]);
  });

  test("performs the write in phase one of the next frame", () => {
    const { clock, coordinator, frameWrites, writes } = constructQueue();
    frameWrites.adopt(coordinator);

    expect(frameWrites.request("follow-tail", (geometry) => geometry.contentHeight - 100)).toBe(
      true,
    );
    expect(writes).toEqual([]);

    clock.runFrame();

    expect(writes).toEqual([{ caller: "follow-tail", targetScrollTop: 1900 }]);
    expect(frameWrites.pendingCount).toBe(0);
  });

  test("hands every caller in one frame the same geometry sample", () => {
    const { clock, coordinator, frameWrites } = constructQueue();
    frameWrites.adopt(coordinator);
    const sampled: number[] = [];

    frameWrites.request("follow-tail", (geometry) => {
      sampled.push(geometry.scrollTop);
      return undefined;
    });
    frameWrites.request("hold-reading-position", (geometry) => {
      sampled.push(geometry.scrollTop);
      return undefined;
    });

    clock.runFrame();

    expect(sampled).toEqual([100, 100]);
  });

  test("coalesces per caller and keeps the last computation", () => {
    const { clock, coordinator, frameWrites, writes } = constructQueue();
    frameWrites.adopt(coordinator);

    frameWrites.request("follow-tail", () => 500);
    frameWrites.request("follow-tail", () => 700);
    expect(frameWrites.pendingCount).toBe(1);

    clock.runFrame();

    expect(writes).toEqual([{ caller: "follow-tail", targetScrollTop: 700 }]);
  });

  test("two callers both get their turn, in submission order", () => {
    const { clock, coordinator, frameWrites, writes } = constructQueue();
    frameWrites.adopt(coordinator);

    frameWrites.request("hold-reading-position", () => 300);
    frameWrites.request("prune-compensation", () => 320);

    clock.runFrame();

    expect(writes).toEqual([
      { caller: "hold-reading-position", targetScrollTop: 300 },
      { caller: "prune-compensation", targetScrollTop: 320 },
    ]);
  });

  test("a computation that withdraws writes nothing", () => {
    const { clock, coordinator, frameWrites, writes } = constructQueue();
    frameWrites.adopt(coordinator);

    frameWrites.request("find-match", () => undefined);
    clock.runFrame();

    expect(writes).toEqual([]);
  });

  test("a request whose surface has no sample yet writes nothing", () => {
    const { clock, coordinator, frameWrites, writes, setGeometry } = constructQueue();
    frameWrites.adopt(coordinator);
    setGeometry(undefined);

    frameWrites.request("follow-tail", () => 900);
    clock.runFrame();

    expect(writes).toEqual([]);
  });

  test("adopting the same coordinator twice is a no-op and a second one throws", () => {
    const { clock, coordinator, frameWrites } = constructQueue();
    frameWrites.adopt(coordinator);

    expect(() => {
      frameWrites.adopt(coordinator);
    }).not.toThrow();
    expect(() => {
      frameWrites.adopt(new LedgerFrameCoordinator({ clock }));
    }).toThrow(/one controller writes inside one frame/);
  });

  test("release cancels the submitted task, so a torn-down controller writes nothing", () => {
    const { clock, coordinator, frameWrites, writes } = constructQueue();
    frameWrites.adopt(coordinator);

    frameWrites.request("follow-tail", () => 900);
    frameWrites.release();
    clock.runFrame();

    expect(writes).toEqual([]);
    expect(coordinator.pendingTaskCount).toBe(0);
    expect(frameWrites.request("follow-tail", () => 900)).toBe(false);
  });
});
