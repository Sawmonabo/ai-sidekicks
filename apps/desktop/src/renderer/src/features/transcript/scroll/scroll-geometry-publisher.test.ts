// The publisher driven directly with three numbers: the tail arithmetic, the replay, and
// which sample wakes a subscriber, without a stand-in scroll container, batch or clock.

import { beforeEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import {
  TRANSCRIPT_GEOMETRY_EPSILON_PX,
  TRANSCRIPT_TAIL_TOLERANCE_PX,
} from "../viewport/viewport-constants.js";
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

  it("counts the tolerance from the bottom rather than from the offset", () => {
    const withinTolerance = publisher.publish(
      readingAt(4500 - TRANSCRIPT_TAIL_TOLERANCE_PX),
      "scroll",
    );
    expect(withinTolerance.distanceFromTailPx).toBe(TRANSCRIPT_TAIL_TOLERANCE_PX);
    expect(withinTolerance.isAtTail).toBe(true);
  });

  it("negative control: a reader one pixel past the tolerance is not following", () => {
    // Without this the two cases above would pass for a publisher that always says at-tail.
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

  it("negative control: a publisher that published nothing replays nothing", () => {
    // Without this the case above would pass over a replayed fabricated zero sample.
    const received: ScrollGeometry[] = [];
    publisher.subscribe((geometry) => received.push(geometry));
    expect(received).toStrictEqual([]);
    expect(publisher.lastGeometry).toBeUndefined();
  });

  it("wakes nobody for a sample identical to the one they already hold", () => {
    publisher.publish(readingAt(120), "scroll");
    const received: ScrollGeometry[] = [];
    publisher.subscribe((geometry) => received.push(geometry));
    received.length = 0;
    publisher.publish(readingAt(120 + TRANSCRIPT_GEOMETRY_EPSILON_PX / 2), "scroll");
    expect(received).toStrictEqual([]);
  });

  it("negative control: a move past the epsilon does wake them", () => {
    publisher.publish(readingAt(120), "scroll");
    const received: ScrollGeometry[] = [];
    publisher.subscribe((geometry) => received.push(geometry));
    received.length = 0;
    publisher.publish(readingAt(121), "scroll");
    expect(received.map((geometry) => geometry.scrollTop)).toStrictEqual([121]);
  });

  it("records a suppressed sample and returns it, so no caller reads twice", () => {
    // Suppression is about waking subscribers, not holding the reading: the caller must not reread.
    publisher.publish(readingAt(120), "scroll");
    const suppressed = publisher.publish(readingAt(120), "resize");
    expect(suppressed.cause).toBe("resize");
    expect(publisher.lastGeometry).toStrictEqual(suppressed);
  });

  it("treats provenance as provenance: a new cause and time decide nothing", () => {
    publisher.publish(readingAt(120), "scroll");
    const received: ScrollGeometry[] = [];
    publisher.subscribe((geometry) => received.push(geometry));
    received.length = 0;
    clock.advance(1_000);
    publisher.publish(readingAt(120), "resize");
    expect(received).toStrictEqual([]);
  });

  it("stamps the sample from the clock seam rather than from wall time", () => {
    clock.advance(4_200);
    expect(publisher.publish(readingAt(0), "scroll").sampledAt).toBe(4_200);
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
