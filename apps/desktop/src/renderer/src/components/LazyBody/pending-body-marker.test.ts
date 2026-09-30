// The pending marker: what carries it and what reads it back, in one suite so the attribute
// is not spelled twice.

import { describe, expect, it } from "vitest";

import {
  PENDING_BODY_ATTRIBUTE,
  PENDING_BODY_SELECTOR,
  findPendingBodies,
  listPendingBodyNames,
} from "./pending-body-marker.js";

/** A tree with one marked descendant per kind, and one unmarked sibling. */
function treeWithPendingKinds(...kinds: readonly string[]): HTMLElement {
  const root = document.createElement("section");
  const settled = document.createElement("div");
  settled.textContent = "a body that arrived";
  root.append(settled);
  for (const kind of kinds) {
    const marker = document.createElement("span");
    marker.setAttribute(PENDING_BODY_ATTRIBUTE, kind);
    root.append(marker);
  }
  return root;
}

describe("the pending pane-body marker", () => {
  it("composes its selector from the attribute rather than restating it", () => {
    expect(PENDING_BODY_SELECTOR).toBe(`[${PENDING_BODY_ATTRIBUTE}]`);
  });

  // Negative control: a tree with no marker reports none.
  it("reports nothing for a tree with no pending body", () => {
    expect(findPendingBodies(treeWithPendingKinds())).toHaveLength(0);
    expect(listPendingBodyNames(treeWithPendingKinds())).toEqual([]);
  });

  it("finds a pending body among settled siblings", () => {
    expect(listPendingBodyNames(treeWithPendingKinds("diff"))).toEqual(["diff"]);
  });

  it("names every pending kind, in document order", () => {
    expect(listPendingBodyNames(treeWithPendingKinds("diff", "inspector", "terminal"))).toEqual([
      "diff",
      "inspector",
      "terminal",
    ]);
  });

  // The root itself counts, since a capture may hand over one pane's element.
  it("includes the root when the root is itself the marker", () => {
    const marker = document.createElement("span");
    marker.setAttribute(PENDING_BODY_ATTRIBUTE, "terminal");
    expect(listPendingBodyNames(marker)).toEqual(["terminal"]);
  });

  it("reports the root and its descendants together", () => {
    const root = treeWithPendingKinds("diff");
    root.setAttribute(PENDING_BODY_ATTRIBUTE, "browser");
    expect(listPendingBodyNames(root)).toEqual(["browser", "diff"]);
  });

  // A marker with no value must still be reported as pending.
  it("reports an unnamed marker rather than dropping it", () => {
    const root = document.createElement("section");
    const marker = document.createElement("span");
    marker.setAttribute(PENDING_BODY_ATTRIBUTE, "");
    root.append(marker);
    expect(listPendingBodyNames(root)).toEqual([""]);
  });
});
