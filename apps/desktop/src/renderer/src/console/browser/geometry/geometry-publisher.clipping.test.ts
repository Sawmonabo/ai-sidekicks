import { afterEach, describe, expect, it, vi } from "vitest";

import { AirspaceRegistry, ManualClock } from "../../core/index.js";
import { PaneGeometryPublisher } from "./geometry-publisher.js";
import type { PaneRect } from "./pane-geometry.js";
import { elementWithRect, RecordingViewHost, rect } from "./geometry-publisher.test-support.js";

// What the publisher DOES with a clipping ancestor, which is the only half of this
// question that is still this family's.
//
// WHICH ancestors clip moved to `primitives/clipping-ancestors.ts` and its suite — the
// vocabulary, the per-member cases, and the closed-union foil are there, beside the
// declaration they are about. What could not move is this: that the sample the publisher
// hands its host is narrowed by the ancestor's box rather than being the pane's own.
describe("PaneGeometryPublisher — a clipping ancestor narrows the published rect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Report one computed `overflow` for ONE element and `visible` for every other.
   *
   * Scoped rather than blanket, because the walk runs to the document root: a blanket
   * answer makes `body` and the document element clippers too, and both report the
   * zero box an unlaid-out environment gives them — so every case would read a pane
   * clipped to nothing whichever value it named, which is no test at all.
   */
  function withComputedOverflow(clipper: Element, overflow: string): void {
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (subject: Element) =>
        (subject === clipper
          ? { overflowX: overflow, overflowY: overflow }
          : { overflowX: "visible", overflowY: "visible" }) as CSSStyleDeclaration,
    );
  }

  /**
   * The pane's published rectangle under one ancestor whose box is half its width,
   * with that ancestor reporting the named `overflow`.
   */
  function publishedRectUnder(overflow: string): PaneRect | undefined {
    const clipper = elementWithRect(rect(0, 0, 50, 100));
    const hostElement = elementWithRect(rect(0, 0, 100, 100));
    clipper.append(hostElement);
    withComputedOverflow(clipper, overflow);
    const host = new RecordingViewHost();
    const clock = new ManualClock();
    const publisher = new PaneGeometryPublisher({
      host,
      clock,
      occlusion: new AirspaceRegistry(),
    });
    publisher.observe(hostElement);
    clock.runFrame();
    publisher.dispose();
    clipper.remove();
    return host.samples[0]?.rect;
  }

  it("subtracts the ancestor's box from what it publishes", () => {
    expect(publishedRectUnder("hidden")).toStrictEqual(rect(0, 0, 50, 100));
  });

  it("negative control: an ancestor that does not clip leaves the pane's own box", () => {
    // Without this, the case above would pass over a publisher that intersected with
    // every ancestor it walked, which would report a pane narrowed for having a parent.
    expect(publishedRectUnder("visible")).toStrictEqual(rect(0, 0, 100, 100));
  });
});
