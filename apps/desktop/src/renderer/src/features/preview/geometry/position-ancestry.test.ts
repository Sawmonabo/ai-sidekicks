// The sibling-growth reading no other position source takes, and the case that must stay cheap:
// a document mutating under a pane that moves nothing. The cases drive the fake size seam
// because this test environment lays nothing out (every box measures zero), so appending text
// would pass over an observer that was never armed.

import { afterEach, describe, expect, it, vi } from "vitest";

import { POSITION_SIBLING_OBSERVER_CAP } from "../preview-caps.js";
import { installFakeResizeObserver } from "@test/helpers/element-resize.js";
import { detachAttachedRoots, trackAttachedRoot } from "./element-motion.test-support.js";
import {
  readAncestrySiblings,
  readPositionAncestry,
  SiblingSizeObservers,
} from "./position-ancestry.js";

afterEach(() => {
  vi.unstubAllGlobals();
  detachAttachedRoots();
});

/**
 * `root > (fixedSibling, ancestor > (element, paneSibling))`, in the live document. `ancestor`
 * is the fixed-size box the pane sits in, `paneSibling` the auto-sized box beside the pane, and
 * `fixedSibling` a box beside the ancestor, which moves the pane as a sibling beside it does.
 */
function attachedBoxTree(): {
  readonly root: HTMLElement;
  readonly ancestor: HTMLElement;
  readonly element: HTMLElement;
  readonly paneSibling: HTMLElement;
  readonly fixedSibling: HTMLElement;
} {
  const root = document.createElement("div");
  const ancestor = document.createElement("div");
  const element = document.createElement("div");
  const paneSibling = document.createElement("div");
  const fixedSibling = document.createElement("div");
  ancestor.append(element, paneSibling);
  root.append(fixedSibling, ancestor);
  document.body.append(root);
  trackAttachedRoot(root);
  return { root, ancestor, element, paneSibling, fixedSibling };
}

describe("readAncestrySiblings", () => {
  it("names the boxes beside the element and beside each of its ancestors", () => {
    const boxes = attachedBoxTree();
    const siblings = readAncestrySiblings(boxes.element, readPositionAncestry(boxes.element));

    expect(siblings).toContain(boxes.paneSibling);
    expect(siblings).toContain(boxes.fixedSibling);
  });

  it("negative control: nothing on the ancestry path is named", () => {
    // Each is already watched for size by the ancestor arm; naming one here would arm a second
    // observer for a known fact and count boxes twice.
    const boxes = attachedBoxTree();
    const siblings = readAncestrySiblings(boxes.element, readPositionAncestry(boxes.element));

    expect(siblings).not.toContain(boxes.element);
    expect(siblings).not.toContain(boxes.ancestor);
    expect(siblings).not.toContain(boxes.root);
  });

  it("stops at the bound, nearest sibling first", () => {
    // A pane inside a live feed has as many siblings as the feed has rows. The set
    // stays bounded, and what survives the cut is the box closest to the pane.
    const boxes = attachedBoxTree();
    for (let extra = 0; extra < POSITION_SIBLING_OBSERVER_CAP * 2; extra += 1) {
      boxes.ancestor.append(document.createElement("div"));
    }
    const siblings = readAncestrySiblings(boxes.element, readPositionAncestry(boxes.element));

    expect(siblings.length).toBe(POSITION_SIBLING_OBSERVER_CAP);
    expect(siblings[0]).toBe(boxes.paneSibling);
  });
});

describe("SiblingSizeObservers", () => {
  it("reports a sibling whose own box changed, which no other source can see", () => {
    const resizeObserver = installFakeResizeObserver();
    const boxes = attachedBoxTree();
    const onSizeChange = vi.fn();
    const observers = new SiblingSizeObservers(onSizeChange);
    observers.watch(readAncestrySiblings(boxes.element, readPositionAncestry(boxes.element)));

    // The auto-sized sibling grows: a text-node rewrite or a nested insertion inside
    // it changes its box and nothing else's.
    resizeObserver.deliverFor(boxes.paneSibling);
    expect(onSizeChange).toHaveBeenCalledTimes(1);

    // And a sibling one level up, which is the same case a level out.
    resizeObserver.deliverFor(boxes.fixedSibling);
    expect(onSizeChange).toHaveBeenCalledTimes(2);
    observers.dispose();
  });

  it("negative control: a box that is not beside the ancestry reports nothing", () => {
    // The cost half: a box inside a sibling changing (a rewritten label, an appended feed row)
    // reaches the observer only if it changed the sibling's own box, and the platform decides
    // that. That is why this is a size reading and not a widened mutation watch.
    const resizeObserver = installFakeResizeObserver();
    const boxes = attachedBoxTree();
    const deepChild = document.createElement("span");
    boxes.paneSibling.append(deepChild);
    const unrelatedRoot = document.createElement("div");
    const unrelatedChild = document.createElement("div");
    unrelatedRoot.append(unrelatedChild);
    document.body.append(unrelatedRoot);
    trackAttachedRoot(unrelatedRoot);

    const onSizeChange = vi.fn();
    const observers = new SiblingSizeObservers(onSizeChange);
    observers.watch(readAncestrySiblings(boxes.element, readPositionAncestry(boxes.element)));

    resizeObserver.deliverFor(deepChild);
    resizeObserver.deliverFor(unrelatedChild);
    expect(onSizeChange).not.toHaveBeenCalled();
    observers.dispose();
  });

  it("releases a box that has stopped being a sibling and keeps the ones that have not", () => {
    const resizeObserver = installFakeResizeObserver();
    const boxes = attachedBoxTree();
    const onSizeChange = vi.fn();
    const observers = new SiblingSizeObservers(onSizeChange);
    observers.watch([boxes.paneSibling, boxes.fixedSibling]);
    const observedAfterFirstWatch = resizeObserver.observedCount();

    observers.watch([boxes.fixedSibling]);
    expect(observers.watchedCount).toBe(1);
    // The survivor is not re-armed: re-observing the whole set would raise an initial delivery
    // for every box on every reorder.
    expect(resizeObserver.observedCount()).toBe(observedAfterFirstWatch);

    resizeObserver.deliverFor(boxes.paneSibling);
    expect(onSizeChange).not.toHaveBeenCalled();
    resizeObserver.deliverFor(boxes.fixedSibling);
    expect(onSizeChange).toHaveBeenCalledTimes(1);
    observers.dispose();
  });

  it("arms nothing once disposed", () => {
    const resizeObserver = installFakeResizeObserver();
    const boxes = attachedBoxTree();
    const onSizeChange = vi.fn();
    const observers = new SiblingSizeObservers(onSizeChange);
    observers.watch([boxes.paneSibling]);
    observers.dispose();

    expect(observers.watchedCount).toBe(0);
    resizeObserver.deliverFor(boxes.paneSibling);
    expect(onSizeChange).not.toHaveBeenCalled();
  });
});
