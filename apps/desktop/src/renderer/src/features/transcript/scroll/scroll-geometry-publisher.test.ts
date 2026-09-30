// The publisher driven directly with three numbers: the tail arithmetic and the replay,
// without a stand-in scroll container, batch or clock.

import { beforeEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { TRANSCRIPT_TAIL_TOLERANCE_PX } from "../viewport/viewport-constants.js";
import {
  ScrollGeometryPublisher,
  type ScrollGeometryReading,
} from "./scroll-geometry-publisher.js";
import type { ScrollGeometry } from "./geometry-sample.js";

let clock: ManualClock;
let publisher: ScrollGeometryPublisher;

beforeEach(() => {
  clock = new ManualClock();
  publisher = new ScrollGeometryPublisher({ clock });
});

function readingAt(
  scrollTop: number,
  viewportHeight = 500,
  contentHeight = 5000,
): ScrollGeometryReading {
  return { scrollTop, viewportHeight, contentHeight };
}

describe("the transcript geometry publisher — the tail", () => {
  it("calls the viewport at the tail once it is within the tolerance", () => {
    const geometry = publisher.publish(readingAt(4500), "scroll");
    expect(geometry.isAtTail).toBe(true);
    expect(geometry.distanceFromTailPx).toBe(0);
  });

  it("a reader one pixel past the tolerance is not following", () => {
    // The edge of the tolerance: a publisher that always says at-tail fails here.
    const outside = publisher.publish(readingAt(4500 - TRANSCRIPT_TAIL_TOLERANCE_PX - 1), "scroll");
    expect(outside.distanceFromTailPx).toBe(TRANSCRIPT_TAIL_TOLERANCE_PX + 1);
    expect(outside.isAtTail).toBe(false);
  });

  it("floors the distance rather than reporting a negative one past the end", () => {
    // A prune between two frames shrinks the content under a held offset; the negative
    // difference would put a follower past the tail.
    expect(publisher.publish(readingAt(9000), "resize").distanceFromTailPx).toBe(0);
  });
});

describe("the transcript geometry publisher — who is woken", () => {
  it("replays the last sample to a subscriber that arrives after it", () => {
    publisher.publish(readingAt(0), "scroll");
    const received: ScrollGeometry[] = [];
    publisher.subscribe((geometry) => received.push(geometry));
    expect(received).toHaveLength(1);
    expect(received[0]?.contentHeight).toBe(5000);
  });

  it("drops every subscriber on clear, and keeps the sample it holds", () => {
    publisher.publish(readingAt(0), "scroll");
    const received: ScrollGeometry[] = [];
    publisher.subscribe((geometry) => received.push(geometry));
    received.length = 0;
    publisher.clear();
    publisher.publish(readingAt(900), "scroll");
    expect(received).toStrictEqual([]);
    expect(publisher.lastGeometry?.scrollTop).toBe(900);
  });
});
