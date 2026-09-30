// Content-driven layout, wired: a sibling grows and the pane's position is re-read.
// `position-ancestry.test.ts` owns the reading; this file owns the claim it cannot make about
// itself, that the composed position observer arms it and that a box it must not watch reaches
// nothing.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { installFakeResizeObserver } from "@test/helpers/element-resize.js";
import { observeElementPosition } from "./element-motion.js";
import {
  detachAttachedRoots,
  settleMutationRecords,
  trackAttachedRoot,
} from "./element-motion.test-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  detachAttachedRoots();
});

/**
 * `root > ancestor > (element, sibling)`, in the live document. The ancestor is fixed-size, so
 * it is never relaid; the sibling is auto-sized, so a text rewrite or nested insertion inside it
 * changes its box and pushes the element across the screen.
 */
function attachedNeighborhood(): {
  readonly ancestor: HTMLElement;
  readonly element: HTMLElement;
  readonly sibling: HTMLElement;
} {
  const root = document.createElement("div");
  const ancestor = document.createElement("div");
  const element = document.createElement("div");
  const sibling = document.createElement("div");
  ancestor.append(element, sibling);
  root.append(ancestor);
  document.body.append(root);
  trackAttachedRoot(root);
  return { ancestor, element, sibling };
}

describe("observeElementPosition — content-driven layout", () => {
  it("reports an auto-sized sibling growing, which moves the element and resizes none of its boxes", () => {
    const resizeObserver = installFakeResizeObserver();
    const { element, sibling } = attachedNeighborhood();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    // A rewritten text node or nested insertion changes the sibling's box, and no ancestor's.
    resizeObserver.deliverFor(sibling);

    expect(onMove).toHaveBeenCalledTimes(1);
    detach();
  });

  it("watches a box that becomes a sibling after the observation was installed", () => {
    const resizeObserver = installFakeResizeObserver();
    const { ancestor, element } = attachedNeighborhood();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    const arrival = document.createElement("div");
    ancestor.append(arrival);
    return settleMutationRecords().then(() => {
      onMove.mockClear();
      resizeObserver.deliverFor(arrival);

      expect(onMove).toHaveBeenCalledTimes(1);
      detach();
    });
  });

  it("negative control: a box inside the element is content, not placement", () => {
    // Without this, an observer that watched every descendant would fire on every render of
    // whatever the pane contains.
    const resizeObserver = installFakeResizeObserver();
    const { element } = attachedNeighborhood();
    const child = document.createElement("span");
    element.append(child);
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    onMove.mockClear();
    resizeObserver.deliverFor(child);

    expect(onMove).not.toHaveBeenCalled();
    detach();
  });

  it("releases every sibling observer when the observation is detached", () => {
    const resizeObserver = installFakeResizeObserver();
    const { element, sibling } = attachedNeighborhood();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    detach();
    onMove.mockClear();
    resizeObserver.deliverFor(sibling);

    expect(onMove).not.toHaveBeenCalled();
    expect(resizeObserver.liveObserverCount()).toBe(0);
  });
});
