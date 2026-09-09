// A resize publishes the ledger's box immediately; the row pass behind it still waits.
//
// ITS OWN FILE because the subject needs a real DOM element and `scroll-chokepoint.test.ts`
// deliberately drives a structural stand-in — that file's own header says why, and the two
// harnesses cannot be one. `OverflowMeasurementBatch.observeResize` narrows its subject
// with `instanceof Element` and skips anything else, so the stand-in installs no observer
// and this path is unreachable from there.
//
// WHAT IT PINS. The resize trigger used to do two jobs on one coalescing frame: publish the
// box the virtualizer ranges against, and re-measure clamped rows. Only the second may be
// late. `ManualClock.advance` excludes frames deliberately — `runFrame` is a separate
// control so a frozen clock never reports a paint its holder did not release — and
// `bridge/console-bridge.ts`' `consoleClockFor` hands a fixture build exactly that clock,
// so the deferred publication was not late but indefinite: measured on the endurance tier,
// the ledger published geometry once, from `attach`, and spent two hundred churn cycles
// ranging a 149 px viewport against the 32 px box it had at mount.

import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { ManualClock } from "../../../core/index.js";
import { LedgerScrollController } from "./scroll-chokepoint.js";
import type { LedgerGeometry } from "../measurement/geometry-sample.js";
import type { LedgerScrollSurface } from "./scroll-chokepoint.js";

let clock: ManualClock;

beforeEach(() => {
  clock = new ManualClock();
});

describe("the scroll chokepoint — a resize publishes the box without a frame", () => {
  // THE ELEMENT IS REAL HERE AND A STAND-IN EVERYWHERE ELSE, because this is the one
  // claim about a path the stand-in cannot reach: `observeResize` narrows its subject
  // with `instanceof Element` and skips anything else, so a structural surface installs
  // no observer at all. The geometry reads are defined onto it because `happy-dom`
  // answers zero for every one.
  //
  // AND THE BOX HAS TO ACTUALLY GROW. A publication whose sample matches the one the
  // subscribers already hold wakes nobody, by design — so a case that fired a resize
  // over an unchanged element would read as starvation whether or not the seam worked.
  interface GrowableSurface {
    readonly surface: LedgerScrollSurface;
    growTo: (clientHeight: number) => void;
  }

  function growableElement(clientHeight: number, scrollHeight: number): GrowableSurface {
    const element = document.createElement("div");
    let currentClientHeight = clientHeight;
    Object.defineProperty(element, "clientHeight", { get: () => currentClientHeight });
    Object.defineProperty(element, "scrollHeight", { get: () => scrollHeight });
    return {
      surface: element,
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
    // THE DEFECT THIS RULES OUT, measured on the endurance tier before the split: the
    // publication rode the batch's coalescing frame, `ManualClock.advance` excludes
    // frames deliberately, and a fixture build hands the console exactly that clock —
    // so the ledger published geometry once, from `attach`, and then ranged a 149 px
    // viewport against the 32 px box it had at mount for two hundred churn cycles.
    // `clock.runFrame()` is never called below, and that is the whole assertion.
    const observer = installObserverCapture();
    const controller = new LedgerScrollController({ clock });
    const mounted = growableElement(32, 9000);
    const received: LedgerGeometry[] = [];

    controller.attach(mounted.surface);
    controller.subscribeToGeometry((geometry) => received.push(geometry));
    received.length = 0;
    mounted.growTo(640);
    observer.fireResize();

    expect(received.map((geometry) => geometry.viewportHeight)).toStrictEqual([640]);
    expect(received[0]?.cause).toBe("resize");
  });

  it("negative control: the coalesced pass behind it is still waiting on a frame", () => {
    // Which is what keeps the split a SPLIT rather than a removal of the batching: the
    // box escapes the frame and the row measurement does not, so a case that passed by
    // running the pass eagerly would be reporting the opposite design.
    const observer = installObserverCapture();
    const controller = new LedgerScrollController({ clock });
    const measured: number[] = [];
    controller.observeOverflow((geometry) => measured.push(geometry.viewportHeight));

    const mounted = growableElement(32, 9000);
    controller.attach(mounted.surface);
    mounted.growTo(640);
    observer.fireResize();

    expect(measured).toStrictEqual([]);
    clock.runFrame();
    expect(measured).toStrictEqual([640]);
  });
});
