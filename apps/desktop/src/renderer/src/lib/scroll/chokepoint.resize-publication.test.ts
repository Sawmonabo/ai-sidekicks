// A resize publishes the transcript's box immediately; the row pass behind it still waits. A
// fixture clock never releases a frame on `ManualClock.advance`, so a publication that waited on
// one would never arrive.

import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "./chokepoint.js";
import type { ScrollGeometry } from "./geometry/sample.js";
import { createCountingScrollContainer } from "./container.test-support.js";

let clock: ManualClock;

beforeEach(() => {
  clock = new ManualClock();
});

describe("the scroll chokepoint — a resize publishes the box without a frame", () => {
  /** The observer the batch reaches for, with the callback kept so a test can fire it. */
  function installObserverCapture(): { fireResize: () => void } {
    const callbacks: (() => void)[] = [];
    const host = globalThis as { ResizeObserver?: unknown };
    const previous = host.ResizeObserver;
    host.ResizeObserver = class {
      public constructor(callback: () => void) {
        callbacks.push(callback);
      }
      public observe(): void {}
      public disconnect(): void {}
      public unobserve(): void {}
    };
    onTestFinished(() => {
      host.ResizeObserver = previous;
    });
    return {
      fireResize: () => {
        for (const callback of [...callbacks]) {
          callback();
        }
      },
    };
  }

  it("publishes the resized box with no frame released at all", () => {
    // `clock.runFrame()` is never called below, and that is the assertion. The box has to grow:
    // a sample matching the one subscribers hold wakes nobody by design.
    const observer = installObserverCapture();
    const controller = new ScrollController({ clock });
    const scrollContainer = createCountingScrollContainer({ clientHeight: 32, scrollHeight: 9000 });
    const received: ScrollGeometry[] = [];

    controller.attach(scrollContainer);
    controller.subscribeToGeometry((geometry) => received.push(geometry));
    received.length = 0;
    scrollContainer.resizeTo(640, 9000);
    observer.fireResize();

    expect(received.map((geometry) => geometry.viewportHeight)).toStrictEqual([640]);
    expect(received[0]?.cause).toBe("resize");
  });
});
