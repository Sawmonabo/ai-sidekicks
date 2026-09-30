import { afterEach, describe, expect, it, vi } from "vitest";

import { AirspaceRegistry } from "@renderer/lib/airspace-registry.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { PaneGeometryPublisher } from "./geometry-publisher.js";
import type { PaneRect } from "./pane-geometry.js";
import { elementWithRect, RecordingPageHost, rect } from "./geometry-publisher.test-support.js";

// What the publisher does with a clipping ancestor: the sample it hands the page host is
// narrowed by the ancestor's box rather than being the pane's own. Which ancestors clip is
// `lib/clipping-ancestors.ts`'s suite.
describe("PaneGeometryPublisher — a clipping ancestor narrows the published rect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Reports one computed `overflow` for one element and `visible` for every other. Scoped,
   * because the walk runs to the document root and a blanket answer would make `body` clip too,
   * to the zero box an unlaid-out environment reports.
   */
  function withComputedOverflow(clipper: Element, overflow: string): void {
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (subject: Element) =>
        (subject === clipper
          ? { overflowX: overflow, overflowY: overflow }
          : { overflowX: "visible", overflowY: "visible" }) as CSSStyleDeclaration,
    );
  }

  /** The published rectangle under one half-width ancestor reporting the named `overflow`. */
  function publishedRectUnder(overflow: string): PaneRect | undefined {
    const clipper = elementWithRect(rect(0, 0, 50, 100));
    const hostElement = elementWithRect(rect(0, 0, 100, 100));
    clipper.append(hostElement);
    withComputedOverflow(clipper, overflow);
    const pageHost = new RecordingPageHost();
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      pageHost,
      clock,
      occlusion: new AirspaceRegistry(),
    });
    publisher.observe(hostElement);
    clock.runFrame();
    publisher.dispose();
    clipper.remove();
    return pageHost.samples[0]?.rect;
  }

  it("subtracts the ancestor's box from what it publishes", () => {
    expect(publishedRectUnder("hidden")).toStrictEqual(rect(0, 0, 50, 100));
  });

  it("negative control: an ancestor that does not clip leaves the pane's own box", () => {
    // Without this, the case above would pass over a publisher that intersected every ancestor.
    expect(publishedRectUnder("visible")).toStrictEqual(rect(0, 0, 100, 100));
  });
});
