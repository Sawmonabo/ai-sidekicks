// What a geometry sample means, driven directly rather than through a surface.
//
// THE RULES HERE ARE THE ONES THAT MOVED OFF `scroll-chokepoint.ts`: the tail
// arithmetic, the replay, and the decision about which sample is worth waking a
// subscriber for. Each of them used to be reachable only by attaching a stand-in
// surface and scrolling it, which meant a case about the ARITHMETIC had to arrange a
// listener, a batch and a clock first. The publisher takes three numbers, so a case
// about three numbers hands it three numbers.
//
// The module under test is imported and driven; nothing here restates its rule.

import { beforeEach, describe, expect, it } from "vitest";

import { ManualClock } from "../../../core/index.js";
import { LEDGER_GEOMETRY_EPSILON_PX, LEDGER_TAIL_TOLERANCE_PX } from "../frame-bounds.js";
import {
  LedgerGeometryPublisher,
  type LedgerGeometryReading,
} from "./scroll-geometry-publisher.js";
import type { LedgerGeometry } from "../measurement/geometry-sample.js";

let clock: ManualClock;
let publisher: LedgerGeometryPublisher;

beforeEach(() => {
  clock = new ManualClock();
  publisher = new LedgerGeometryPublisher({ clock });
});

/** A viewport-sized box in a taller log, at the offset a case names. */
function readingAt(
  scrollTop: number,
  viewportHeight = 500,
  contentHeight = 5000,
): LedgerGeometryReading {
  return { scrollTop, viewportHeight, contentHeight };
}

describe("the ledger geometry publisher — the tail", () => {
  it("calls the viewport at the tail once it is within the tolerance", () => {
    // MOVED FROM `scroll-chokepoint.test.ts`, where it attached a recording surface and
    // scrolled it to reach the same three numbers. The arithmetic is the publisher's now.
    const geometry = publisher.publish(readingAt(4500), "scroll");
    expect(geometry.isAtTail).toBe(true);
    expect(geometry.distanceFromTailPx).toBe(0);
  });

  it("counts the tolerance from the bottom rather than from the offset", () => {
    const withinTolerance = publisher.publish(readingAt(4500 - LEDGER_TAIL_TOLERANCE_PX), "scroll");
    expect(withinTolerance.distanceFromTailPx).toBe(LEDGER_TAIL_TOLERANCE_PX);
    expect(withinTolerance.isAtTail).toBe(true);
  });

  it("negative control: a reader one pixel past the tolerance is not following", () => {
    // Without this the two cases above would pass over a publisher that answered
    // `isAtTail` for every offset in the log.
    const outside = publisher.publish(readingAt(4500 - LEDGER_TAIL_TOLERANCE_PX - 1), "scroll");
    expect(outside.distanceFromTailPx).toBe(LEDGER_TAIL_TOLERANCE_PX + 1);
    expect(outside.isAtTail).toBe(false);
  });

  it("floors the distance rather than reporting a negative one past the end", () => {
    // A content height that shrank under a held offset — a prune between two frames —
    // produces a negative difference, and a follower reading one would be past the tail.
    expect(publisher.publish(readingAt(9000), "resize").distanceFromTailPx).toBe(0);
  });
});

describe("the ledger geometry publisher — who is woken", () => {
  it("replays the last sample to a subscriber that arrives after it", () => {
    publisher.publish(readingAt(0), "scroll");
    const received: LedgerGeometry[] = [];
    publisher.subscribe((geometry) => received.push(geometry));
    expect(received).toHaveLength(1);
    expect(received[0]?.contentHeight).toBe(5000);
  });

  it("negative control: a publisher that published nothing replays nothing", () => {
    // Without this the case above would pass over a subscription that replayed a
    // fabricated zero sample rather than the one that was published.
    const received: LedgerGeometry[] = [];
    publisher.subscribe((geometry) => received.push(geometry));
    expect(received).toStrictEqual([]);
    expect(publisher.lastGeometry).toBeUndefined();
  });

  it("wakes nobody for a sample identical to the one they already hold", () => {
    publisher.publish(readingAt(120), "scroll");
    const received: LedgerGeometry[] = [];
    publisher.subscribe((geometry) => received.push(geometry));
    received.length = 0;
    publisher.publish(readingAt(120 + LEDGER_GEOMETRY_EPSILON_PX / 2), "scroll");
    expect(received).toStrictEqual([]);
  });

  it("negative control: a move past the epsilon does wake them", () => {
    // Which is what makes the suppression above a comparison rather than a mute.
    publisher.publish(readingAt(120), "scroll");
    const received: LedgerGeometry[] = [];
    publisher.subscribe((geometry) => received.push(geometry));
    received.length = 0;
    publisher.publish(readingAt(121), "scroll");
    expect(received.map((geometry) => geometry.scrollTop)).toStrictEqual([121]);
  });

  it("records a suppressed sample and returns it, so no caller reads twice", () => {
    // The suppression is about waking subscribers and not about holding the reading:
    // a caller handed `undefined` here would go back to the surface for numbers the
    // publisher already had.
    publisher.publish(readingAt(120), "scroll");
    const suppressed = publisher.publish(readingAt(120), "resize");
    expect(suppressed.cause).toBe("resize");
    expect(publisher.lastGeometry).toStrictEqual(suppressed);
  });

  it("treats provenance as provenance: a new cause and time decide nothing", () => {
    publisher.publish(readingAt(120), "scroll");
    const received: LedgerGeometry[] = [];
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
    const received: LedgerGeometry[] = [];
    publisher.subscribe((geometry) => received.push(geometry));
    received.length = 0;
    publisher.clear();
    publisher.publish(readingAt(900), "scroll");
    expect(received).toStrictEqual([]);
    expect(publisher.lastGeometry?.scrollTop).toBe(900);
  });
});
