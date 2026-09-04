// The sixth source, wired: a sibling grows and the pane's position is re-read.
//
// `position-ancestry.test.ts` owns the reading — which boxes are watched, what the
// bound gives up, and what stays asleep. This file owns the only claim that reading
// cannot make about itself: that the composed position observer actually ARMS it, and
// that a box it must not watch still reaches nothing. A reading nothing consumes is a
// module with a test and no effect.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../core/index.js";
import { installFakeResizeObserver } from "../primitives/element-resize.test-support.js";
import { observeElementPosition } from "./element-motion.js";
import { settleMutationRecords } from "./element-motion.test-support.js";

const attachedRoots: Element[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of attachedRoots.splice(0)) {
    root.remove();
  }
});

/**
 * `root > ancestor > (element, sibling)`, in the live document.
 *
 * The shape the finding describes: the ancestor is fixed-size, so it is never relaid;
 * the sibling is auto-sized, so a text-node rewrite or a nested insertion inside it
 * changes ITS box and pushes the element across the screen.
 */
function attachedNeighbourhood(): {
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
  attachedRoots.push(root);
  return { ancestor, element, sibling };
}

describe("observeElementPosition — content-driven layout", () => {
  it("reports an auto-sized sibling growing, which moves the element and resizes none of its boxes", () => {
    const resizeObserver = installFakeResizeObserver();
    const { element, sibling } = attachedNeighbourhood();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    // What a rewritten text node or a nested insertion inside that sibling produces:
    // the sibling's own box changed, and no ancestor's did.
    resizeObserver.deliverFor(sibling);

    expect(onMove).toHaveBeenCalledTimes(1);
    detach();
  });

  it("watches a box that becomes a sibling after the observation was installed", () => {
    const resizeObserver = installFakeResizeObserver();
    const { ancestor, element } = attachedNeighbourhood();
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
    // Without this, an observer that watched every descendant to catch the sibling
    // case would fire on every render of whatever the pane contains — the per-row
    // layout cost the bounded sibling reading exists to avoid.
    const resizeObserver = installFakeResizeObserver();
    const { element } = attachedNeighbourhood();
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
    const { element, sibling } = attachedNeighbourhood();
    const onMove = vi.fn();

    const detach = observeElementPosition({ element, clock: new ManualClock(), onMove });
    detach();
    onMove.mockClear();
    resizeObserver.deliverFor(sibling);

    expect(onMove).not.toHaveBeenCalled();
    expect(resizeObserver.liveObserverCount()).toBe(0);
  });
});
