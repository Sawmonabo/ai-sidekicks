// The reading no other position source can take: a sibling that grew.
//
// The other five position sources are covered beside the observer that composes
// them. This file is about the sixth, and about the case that has to stay cheap: a
// document mutating under a pane that moves nothing.
//
// WHY THE ASSERTIONS DRIVE THE SIZE SEAM RATHER THAN WRITING TEXT INTO A NODE. The
// environment these console tiers run on lays nothing out — every box measures zero,
// and a rewritten text node changes no reported size — so a case that appended a
// character and waited would pass over an observer that was never armed. The claim
// being made is which BOXES are watched, so the fake size seam delivers to one of
// them by name and the negative controls deliver to boxes that must not be watched.

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
 * `root > (fixedSibling, ancestor > (element, paneSibling))`, in the live document.
 *
 * The shape the finding describes: `ancestor` is the fixed-size box the pane sits in,
 * `paneSibling` is the auto-sized box beside the pane whose text grows, and
 * `fixedSibling` is a box beside the ANCESTOR, which is the other half of the case —
 * a sibling one level up moves the pane exactly as a sibling beside it does.
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
    // Every one of these is already watched for size by the ancestor arm. Naming one
    // here would arm a second observer to learn a fact the caller already has, and
    // would make the bound below count boxes twice.
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
    // The cost half of the finding, and the whole reason this is a size reading
    // rather than a widened subtree mutation watch: a box INSIDE a sibling changing
    // — a rewritten label, an appended feed row — reaches this observer only if it
    // changed the sibling's own box, and the platform decides that, not this module.
    // A box nested somewhere else entirely reaches it never.
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
    // The survivor is not re-armed: a diff that disconnected and re-observed the
    // whole set would raise an initial delivery for every box on every reorder.
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
