// A resize publishes the transcript's box immediately; the row pass behind it still waits.
// A separate file from `scroll-chokepoint.test.ts`, which drives a structural stand-in: the
// batch's `observeResize` skips anything that is not an `Element`, so this path needs a real one.
// `ManualClock.advance` excludes frames deliberately, and a fixture build's clock is exactly
// that, so a publication riding the coalescing frame never arrived: on the endurance tier the
// transcript ranged a 149 px viewport against the 32 px box it had at mount for 200 churn cycles.

import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { ScrollController } from "./scroll-chokepoint.js";
import type { ScrollGeometry } from "./geometry-sample.js";
import type { ScrollContainer } from "./scroll-chokepoint.js";

let clock: ManualClock;

beforeEach(() => {
  clock = new ManualClock();
});

describe("the scroll chokepoint — a resize publishes the box without a frame", () => {
  // The element is real because `observeResize` skips a structural stand-in. The geometry reads
  // are defined onto it because `happy-dom` answers zero for each, and the box has to grow: a
  // sample matching the one subscribers hold wakes nobody by design.
  interface GrowableScrollContainer {
    readonly scrollContainer: ScrollContainer;
    growTo: (clientHeight: number) => void;
  }

  function growableElement(clientHeight: number, scrollHeight: number): GrowableScrollContainer {
    const element = document.createElement("div");
    let currentClientHeight = clientHeight;
    Object.defineProperty(element, "clientHeight", { get: () => currentClientHeight });
    Object.defineProperty(element, "scrollHeight", { get: () => scrollHeight });
    return {
      scrollContainer: element,
      growTo: (grown: number) => {
        currentClientHeight = grown;
      },
    };
  }

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
    // The publication once rode the batch's coalescing frame, which a fixture clock never
    // releases. `clock.runFrame()` is never called below, and that is the assertion.
    const observer = installObserverCapture();
    const controller = new ScrollController({ clock });
    const mounted = growableElement(32, 9000);
    const received: ScrollGeometry[] = [];

    controller.attach(mounted.scrollContainer);
    controller.subscribeToGeometry((geometry) => received.push(geometry));
    received.length = 0;
    mounted.growTo(640);
    observer.fireResize();

    expect(received.map((geometry) => geometry.viewportHeight)).toStrictEqual([640]);
    expect(received[0]?.cause).toBe("resize");
  });

  it("negative control: the coalesced pass behind it is still waiting on a frame", () => {
    // The box escapes the frame and the row measurement does not; passing by running the pass
    // eagerly would report the opposite design.
    const observer = installObserverCapture();
    const controller = new ScrollController({ clock });
    const measured: number[] = [];
    controller.observeOverflow((geometry) => measured.push(geometry.viewportHeight));

    const mounted = growableElement(32, 9000);
    controller.attach(mounted.scrollContainer);
    mounted.growTo(640);
    observer.fireResize();

    expect(measured).toStrictEqual([]);
    clock.runFrame();
    expect(measured).toStrictEqual([640]);
  });
});
