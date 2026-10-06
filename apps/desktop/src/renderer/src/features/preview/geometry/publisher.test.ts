// The publisher's two promises, read now and write next frame, tested through their failure
// modes: retrying a rejected rectangle republishes it every frame, five invalidations costing five
// writes drags a pane, and a source that never resamples leaves the native view over chrome the
// pane has left.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AirspaceRegistry } from "#renderer/lib/airspace.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { refuse } from "#renderer/lib/refusal/contract.js";
import { RESOLVED_SCHEME_ATTRIBUTE } from "#shared/appearance.js";
import { installFakeResizeObserver } from "#test/helpers/element/resize.js";
import {
  detachAttachedRoots,
  settleMutationRecords,
  trackAttachedRoot,
  withDocumentAnimations,
} from "./element-motion.test-support.js";
import { PaneGeometryPublisher } from "./publisher.js";
import { PAGE_HOST_REFUSAL_ORIGIN, type PageHost } from "./page-host.js";
import type { PaneRect } from "./pane.js";
import {
  elementWithRect,
  moveElementRect,
  RecordingPageHost,
  rect,
} from "./publisher.test-support.js";

function publisherOver(pageHost: PageHost): {
  readonly publisher: PaneGeometryPublisher;
  readonly clock: ManualClock;
  readonly occlusion: AirspaceRegistry;
} {
  const clock = new ManualClock();
  const occlusion = new AirspaceRegistry();
  return {
    publisher: new PaneGeometryPublisher({ pageHost, clock, occlusion }),
    clock,
    occlusion,
  };
}

describe("PaneGeometryPublisher", () => {
  it("coalesces a burst into one frame and dedupes an unchanged publish", () => {
    const pageHost = new RecordingPageHost();
    const { publisher, clock } = publisherOver(pageHost);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    publisher.invalidate("window-resize");
    publisher.invalidate("document-scroll");
    publisher.invalidate("layout-mover");
    expect(clock.pendingFrameCount).toBe(1);
    clock.runFrame();
    expect(publisher.publishCount).toBe(1);

    publisher.invalidate("theme-change");
    clock.runFrame();
    expect(publisher.publishCount).toBe(1);
    expect(publisher.lastOutcome()?.status).toBe("deduped");
    publisher.dispose();
  });

  it("unsubscribes rather than retrying when the page host says the pane is gone", () => {
    const pageHost = new RecordingPageHost();
    pageHost.rejectNextWith(
      refuse(PAGE_HOST_REFUSAL_ORIGIN, "pane-gone", "The pane was destroyed."),
    );
    const { publisher, clock } = publisherOver(pageHost);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    clock.runFrame();
    expect(publisher.armedSourceCount).toBe(0);
    expect(publisher.lastOutcome()?.status).toBe("suppressed");

    publisher.invalidate("window-resize");
    clock.runFrame();
    expect(pageHost.samples).toHaveLength(1);
  });

  it("re-samples when an overlay opens, so the view yields without waiting for a scroll", () => {
    const pageHost = new RecordingPageHost();
    const { publisher, clock, occlusion } = publisherOver(pageHost);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    clock.runFrame();
    occlusion.register(() => rect(0, 0, 500, 500));
    clock.runFrame();
    expect(pageHost.samples.at(-1)?.visible).toBe(false);
    publisher.dispose();
  });

  it("is terminal: dispose cancels the queued frame and nothing re-arms", () => {
    const pageHost = new RecordingPageHost();
    const { publisher, clock } = publisherOver(pageHost);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    publisher.dispose();
    expect(clock.pendingCount).toBe(0);
    publisher.invalidate("window-resize");
    expect(clock.pendingCount).toBe(0);
    expect(pageHost.samples).toStrictEqual([]);
  });
});

describe("PaneGeometryPublisher — the theme source", () => {
  afterEach(() => {
    document.documentElement.removeAttribute(RESOLVED_SCHEME_ATTRIBUTE);
  });

  it("resamples when the scheme the page is drawn in turns, under system too", async () => {
    const pageHost = new RecordingPageHost();
    const { publisher, clock } = publisherOver(pageHost);
    publisher.observe(elementWithRect(rect(0, 0, 100, 100)));
    clock.runFrame();

    // Under `system` only the resolved scheme moves; no explicit scheme is written.
    document.documentElement.setAttribute(RESOLVED_SCHEME_ATTRIBUTE, "dark");
    await settleMutationRecords();

    expect(clock.pendingFrameCount).toBe(1);
    publisher.dispose();
  });
});

// Which ancestors clip is `lib/clipping-ancestors.ts`'s suite; this is what the publisher does
// with one.
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
    const { publisher, clock } = publisherOver(pageHost);
    publisher.observe(hostElement);
    clock.runFrame();
    publisher.dispose();
    clipper.remove();
    return pageHost.samples[0]?.rect;
  }

  it("subtracts the ancestor's box from what it publishes", () => {
    expect(publishedRectUnder("hidden")).toStrictEqual(rect(0, 0, 50, 100));
  });
});

// A pane carried by a pane layout reorder, a sibling's relayout or a sliding rail would otherwise
// keep its old rectangle until something unrelated invalidated.
describe("PaneGeometryPublisher — the move source", () => {
  beforeEach(() => {
    installFakeResizeObserver();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    withDocumentAnimations(undefined);
    detachAttachedRoots();
  });

  /** Reorder the pane's parent around it, which is what a pane layout does to its panes. */
  function reorderAround(hostElement: HTMLElement): void {
    const sibling = trackAttachedRoot(document.createElement("div"));
    document.body.insertBefore(sibling, hostElement);
  }

  it("resamples once when the pane's parent is reordered around it", async () => {
    const hostElement = elementWithRect(rect(0, 0, 100, 100));
    const pageHost = new RecordingPageHost();
    const { publisher, clock } = publisherOver(pageHost);
    publisher.observe(hostElement);
    clock.runFrame();
    expect(publisher.publishCount).toBe(1);

    moveElementRect(hostElement, rect(0, 40, 100, 100));
    reorderAround(hostElement);
    await settleMutationRecords();

    expect(clock.pendingFrameCount).toBe(1);
    clock.runFrame();
    expect(publisher.publishCount).toBe(2);
    expect(pageHost.samples.at(-1)?.reason).toBe("layout-mover");
    expect(pageHost.samples.at(-1)?.rect).toStrictEqual(rect(0, 40, 100, 100));
    publisher.dispose();
  });
});

describe("PaneGeometryPublisher — the size source", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resamples on a size delivery for its own host element, and disconnects on dispose", () => {
    const resizeObserver = installFakeResizeObserver();
    const pageHost = new RecordingPageHost();
    const { publisher, clock } = publisherOver(pageHost);
    const hostElement = elementWithRect(rect(0, 0, 100, 100));
    publisher.observe(hostElement);
    clock.runFrame();
    expect(publisher.publishCount).toBe(1);

    moveElementRect(hostElement, rect(0, 0, 100, 240));
    resizeObserver.deliverFor(hostElement);
    clock.runFrame();

    expect(publisher.publishCount).toBe(2);
    expect(pageHost.samples.at(-1)?.reason).toBe("resize-observer");
    expect(pageHost.samples.at(-1)?.rect).toStrictEqual(rect(0, 0, 100, 240));

    publisher.dispose();
    expect(resizeObserver.liveObserverCount()).toBe(0);
  });
});
