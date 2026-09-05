// The sidebar's state object, driven directly: what it notifies, and what it refuses
// to write before the restore has landed.
//
// The ordering is the risky half and it fails quietly: a save that fired from the
// opening defaults would file them over the record the restore was still reading, and
// the result looks exactly like a sidebar nobody had arranged.

import { describe, expect, it } from "vitest";

import { SIDEBAR_DEFAULT_WIDTH_PERCENT } from "../workspace-bounds.js";
import { INITIAL_SIDEBAR_LAYOUT_STATE } from "./sidebar-model.js";
import { SidebarLayout } from "./sidebar-state.js";

/** A layout with a subscriber counting the transitions it was told about. */
function subscribedLayout(): { readonly layout: SidebarLayout; readonly notices: () => number } {
  const layout = new SidebarLayout();
  let count = 0;
  layout.subscribe(() => {
    count += 1;
  });
  return { layout, notices: () => count };
}

describe("the sidebar's state — what it holds before anything is restored", () => {
  it("opens at the default width with nothing open and nothing settled", () => {
    const layout = new SidebarLayout();
    expect(layout.snapshot().state).toStrictEqual(INITIAL_SIDEBAR_LAYOUT_STATE);
    expect(layout.snapshot().hasSettled).toBe(false);
  });

  it("marks itself settled even where the record held nothing", () => {
    // "Nobody has arranged this sidebar yet" is an answer. A surface waiting for a
    // record that will never exist would never announce and would never save.
    const layout = new SidebarLayout();
    layout.adopt(INITIAL_SIDEBAR_LAYOUT_STATE, []);
    expect(layout.snapshot().hasSettled).toBe(true);
  });
});

describe("the sidebar's state — what it notifies", () => {
  it("notifies on a press, a collapse, and a width it did not already hold", () => {
    const { layout, notices } = subscribedLayout();
    layout.pressSection("runs");
    layout.setCollapsed(true);
    layout.recordWidthPercent(SIDEBAR_DEFAULT_WIDTH_PERCENT + 5);
    expect(notices()).toBe(3);
    expect(layout.snapshot().state).toStrictEqual({
      widthPercent: SIDEBAR_DEFAULT_WIDTH_PERCENT + 5,
      isCollapsed: true,
      chosenSectionId: "runs",
    });
  });

  it("says nothing about a width it is already at, so a settled group writes nothing", () => {
    // The group reports its layout on every commit, and a transition per report would
    // queue a durable write per commit for a sidebar nobody moved.
    const { layout, notices } = subscribedLayout();
    layout.recordWidthPercent(SIDEBAR_DEFAULT_WIDTH_PERCENT);
    expect(notices()).toBe(0);
  });

  it("negative control: a width outside the band still lands, clamped", () => {
    // Without this the case above would pass over a `recordWidthPercent` that ignored
    // every width it was given.
    const { layout, notices } = subscribedLayout();
    layout.recordWidthPercent(99);
    expect(notices()).toBe(1);
    expect(layout.snapshot().state.widthPercent).toBeLessThan(99);
  });

  it("toggles the collapse from whichever state it is in", () => {
    const layout = new SidebarLayout();
    layout.toggleCollapsed();
    expect(layout.snapshot().state.isCollapsed).toBe(true);
    layout.toggleCollapsed();
    expect(layout.snapshot().state.isCollapsed).toBe(false);
  });

  it("hands back one snapshot object per transition, which is what the store hook reads", () => {
    // `useSyncExternalStore` compares by identity: a snapshot rebuilt on every read
    // would re-render the column on every pass, and one never rebuilt would render
    // none of the transitions above.
    const layout = new SidebarLayout();
    const before = layout.snapshot();
    expect(layout.snapshot()).toBe(before);
    layout.pressSection("goal");
    expect(layout.snapshot()).not.toBe(before);
  });

  it("drops a subscriber that unsubscribes, so an unmounted column is not notified", () => {
    const layout = new SidebarLayout();
    let count = 0;
    const unsubscribe = layout.subscribe(() => {
      count += 1;
    });
    unsubscribe();
    layout.pressSection("agents");
    expect(count).toBe(0);
  });
});
