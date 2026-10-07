// A resize publishes the transcript's box immediately; the row pass behind it still waits. A
// fixture clock never releases a frame on `ManualClock.advance`, so a publication that waited on
// one would never arrive. Beside a supplied content height, the resize observation is also the
// only place the viewport height comes from after attach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { installFakeResizeObserver } from "#test/helpers/element/resize.js";
import { ScrollController } from "./chokepoint.js";
import type { ScrollGeometry } from "./geometry/sample.js";
import { createCountingScrollContainer } from "./container.test-support.js";

let clock: ManualClock;

beforeEach(() => {
  clock = new ManualClock();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the scroll chokepoint — a resize publishes the box without a frame", () => {
  it("publishes the resized box with no frame released at all", () => {
    // `clock.runFrame()` is never called below, and that is the assertion. The box has to grow:
    // a sample matching the one subscribers hold wakes nobody by design.
    const observer = installFakeResizeObserver();
    const controller = new ScrollController({ clock });
    const scrollContainer = createCountingScrollContainer({ clientHeight: 32, scrollHeight: 9000 });
    const received: ScrollGeometry[] = [];

    controller.attach(scrollContainer);
    controller.subscribeToGeometry((geometry) => received.push(geometry));
    received.length = 0;
    scrollContainer.resizeTo(640, 9000);
    observer.deliverFor(scrollContainer, 640);

    expect(received.map((geometry) => geometry.viewportHeight)).toStrictEqual([640]);
    expect(received[0]?.cause).toBe("resize");
  });

  it("beside a supplied content height, takes the viewport height from the observation", () => {
    const observer = installFakeResizeObserver();
    const controller = new ScrollController({ clock });
    const scrollContainer = createCountingScrollContainer({
      initialScrollTop: 0,
      clientHeight: 32,
      scrollHeight: 9000,
    });
    controller.attach(scrollContainer, () => 3000);

    // The box grew, but no observation has said so: a scroll carries the height attach read,
    // which a scroll reading `clientHeight` would not.
    scrollContainer.resizeTo(640, 9000);
    scrollContainer.moveTo(100);
    expect(controller.geometry?.viewportHeight).toBe(32);

    // Padded 8 px above and below: the observed content box is what the content scrolls in.
    const contentBoxHeightPx = 640 - 2 * 8;
    observer.deliverFor(scrollContainer, contentBoxHeightPx);
    expect(controller.geometry?.viewportHeight).toBe(contentBoxHeightPx);
    expect(controller.geometry?.cause).toBe("resize");

    scrollContainer.moveTo(200);
    expect(controller.geometry?.viewportHeight).toBe(contentBoxHeightPx);
    expect(controller.geometry?.distanceFromTailPx).toBe(3000 - contentBoxHeightPx - 200);
  });
});
