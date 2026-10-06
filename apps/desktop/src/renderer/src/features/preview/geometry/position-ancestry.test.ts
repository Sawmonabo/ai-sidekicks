// The sibling-growth reading no other position source takes, bounded: a pane inside a live feed
// has as many siblings as the feed has rows.

import { afterEach, describe, expect, it, vi } from "vitest";

import { POSITION_SIBLING_OBSERVER_CAP } from "../caps.js";
import { detachAttachedRoots, trackAttachedRoot } from "./element-motion.test-support.js";
import { readAncestrySiblings, readPositionAncestry } from "./position-ancestry.js";

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
  it("stops at the bound, nearest sibling first", () => {
    // The set stays bounded, and what survives the cut is the box closest to the pane.
    const boxes = attachedBoxTree();
    for (let extra = 0; extra < POSITION_SIBLING_OBSERVER_CAP * 2; extra += 1) {
      boxes.ancestor.append(document.createElement("div"));
    }
    const siblings = readAncestrySiblings(boxes.element, readPositionAncestry(boxes.element));

    expect(siblings.length).toBe(POSITION_SIBLING_OBSERVER_CAP);
    expect(siblings[0]).toBe(boxes.paneSibling);
  });
});
