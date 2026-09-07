// The pending marker: what carries it, and what reads it back.
//
// Both halves of one seam in one suite, which is what the package's rule asks for: the
// attribute is written by `PendingPaneBody.tsx` and read by this module, and a suite
// that spelled the string itself would go green over a fallback the day the attribute
// was renamed.

import { describe, expect, it } from "vitest";

import {
  PENDING_PANE_BODY_ATTRIBUTE,
  PENDING_PANE_BODY_SELECTOR,
  pendingPaneBodiesIn,
  pendingPaneKindsIn,
} from "./pending-pane-body.js";

/** A tree with one marked descendant per kind, and one unmarked sibling. */
function treeWithPendingKinds(...kinds: readonly string[]): HTMLElement {
  const root = document.createElement("section");
  const settled = document.createElement("div");
  settled.textContent = "a body that arrived";
  root.append(settled);
  for (const kind of kinds) {
    const marker = document.createElement("span");
    marker.setAttribute(PENDING_PANE_BODY_ATTRIBUTE, kind);
    root.append(marker);
  }
  return root;
}

describe("the pending pane-body marker", () => {
  it("composes its selector from the attribute rather than restating it", () => {
    expect(PENDING_PANE_BODY_SELECTOR).toBe(`[${PENDING_PANE_BODY_ATTRIBUTE}]`);
  });

  // The negative control the reader's clean results rest on: a tree with no marker
  // must report none, or every positive result below is vacuous.
  it("reports nothing for a tree with no pending body", () => {
    expect(pendingPaneBodiesIn(treeWithPendingKinds())).toHaveLength(0);
    expect(pendingPaneKindsIn(treeWithPendingKinds())).toEqual([]);
  });

  it("finds a pending body among settled siblings", () => {
    expect(pendingPaneKindsIn(treeWithPendingKinds("diff"))).toEqual(["diff"]);
  });

  it("names every pending kind, in document order", () => {
    expect(pendingPaneKindsIn(treeWithPendingKinds("diff", "artifact", "runs"))).toEqual([
      "diff",
      "artifact",
      "runs",
    ]);
  });

  // The root itself, which `querySelectorAll` alone would miss: a caller capturing one
  // pane hands this the pane's own element, and reporting that as settled is exactly
  // the failure the marker exists to prevent.
  it("includes the root when the root is itself the marker", () => {
    const marker = document.createElement("span");
    marker.setAttribute(PENDING_PANE_BODY_ATTRIBUTE, "terminal");
    expect(pendingPaneKindsIn(marker)).toEqual(["terminal"]);
  });

  it("reports the root and its descendants together", () => {
    const root = treeWithPendingKinds("diff");
    root.setAttribute(PENDING_PANE_BODY_ATTRIBUTE, "browser");
    expect(pendingPaneKindsIn(root)).toEqual(["browser", "diff"]);
  });

  // A marker with no value is a marker somebody stamped wrong, and a reader that
  // dropped it would report a pending pane as settled.
  it("reports an unnamed marker rather than dropping it", () => {
    const root = document.createElement("section");
    const marker = document.createElement("span");
    marker.setAttribute(PENDING_PANE_BODY_ATTRIBUTE, "");
    root.append(marker);
    expect(pendingPaneKindsIn(root)).toEqual([""]);
  });
});
