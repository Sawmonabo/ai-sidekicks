// The surface watch, driven against fakes rather than against a browser.
//
// Two behaviours decide whether the rail stays sharp: a box change and a pixel-ratio
// change both reach the painter, and releasing the watch stops both. The fakes make
// the second one checkable — a real `ResizeObserver` would let a leaked observation
// pass as a clean run.

import { describe, expect, it } from "vitest";

import type { Unsubscribe } from "../../core/index.js";
import {
  hostDevicePixelRatio,
  watchRailSurface,
  type RailSurfaceObservers,
} from "./rail-surface.js";

/** Observers a case drives by hand, counting what was released. */
interface FakeObservers {
  readonly observers: RailSurfaceObservers;
  /** Elements the box observation was armed on. */
  readonly observedElements: readonly Element[];
  boxReleaseCount(): number;
  ratioReleaseCount(): number;
  reportBoxChange(): void;
  reportRatioChange(): void;
}

function fakeObservers(): FakeObservers {
  const observedElements: Element[] = [];
  const boxSinks: (() => void)[] = [];
  const ratioSinks: (() => void)[] = [];
  let boxReleases = 0;
  let ratioReleases = 0;
  const observers: RailSurfaceObservers = {
    observeBox: (element: Element, onChange: () => void): Unsubscribe => {
      observedElements.push(element);
      boxSinks.push(onChange);
      return () => {
        boxReleases += 1;
      };
    },
    observeDevicePixelRatio: (onChange: () => void): Unsubscribe => {
      ratioSinks.push(onChange);
      return () => {
        ratioReleases += 1;
      };
    },
  };
  return {
    observers,
    observedElements,
    boxReleaseCount: () => boxReleases,
    ratioReleaseCount: () => ratioReleases,
    reportBoxChange: () => {
      for (const sink of boxSinks) {
        sink();
      }
    },
    reportRatioChange: () => {
      for (const sink of ratioSinks) {
        sink();
      }
    },
  };
}

/** A stand-in for the canvas node, which is all the watch ever does with it. */
function railElement(): Element {
  return { nodeName: "CANVAS" } as unknown as Element;
}

describe("rail surface watch — both sources reach the repaint", () => {
  it("repaints when the rendered box moves", () => {
    const fakes = fakeObservers();
    const element = railElement();
    let repaints = 0;
    watchRailSurface(
      element,
      () => {
        repaints += 1;
      },
      fakes.observers,
    );
    expect(fakes.observedElements).toStrictEqual([element]);
    fakes.reportBoxChange();
    expect(repaints).toBe(1);
  });

  it("repaints when the host's pixel ratio moves", () => {
    // A window dragged to a display of a different density: the box is unchanged
    // and the backing store is now the wrong size, which is invisible without this.
    const fakes = fakeObservers();
    let repaints = 0;
    watchRailSurface(
      railElement(),
      () => {
        repaints += 1;
      },
      fakes.observers,
    );
    fakes.reportRatioChange();
    expect(repaints).toBe(1);
  });

  it("releases both observations, so an unmounted rail observes nothing", () => {
    const fakes = fakeObservers();
    const release = watchRailSurface(railElement(), () => undefined, fakes.observers);
    expect(fakes.boxReleaseCount()).toBe(0);
    release();
    expect(fakes.boxReleaseCount()).toBe(1);
    expect(fakes.ratioReleaseCount()).toBe(1);
  });

  it("negative control: nothing repaints on its own", () => {
    // Every case above counts callbacks, and all of them would pass over a watch
    // that fired once at arm time regardless of what moved.
    const fakes = fakeObservers();
    let repaints = 0;
    watchRailSurface(
      railElement(),
      () => {
        repaints += 1;
      },
      fakes.observers,
    );
    expect(repaints).toBe(0);
  });
});

describe("rail surface watch — the host's pixel ratio", () => {
  it("reads a usable ratio or falls back to one", () => {
    // A shim reports nothing and a browser reports 1, 2, or 3. Both answers are
    // real; what would not be is a zero or a NaN reaching the store's arithmetic.
    const ratio = hostDevicePixelRatio();
    expect(Number.isFinite(ratio)).toBe(true);
    expect(ratio).toBeGreaterThan(0);
  });
});
