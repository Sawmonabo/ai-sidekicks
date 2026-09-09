// What the sidebar DOES, as against what it shows: the column's own collapse and the
// rail that recovers it, the three acts a palette seat reaches it through, and the
// restore — rendered as a refusal rather than swallowed, and announced exactly once.
//
// Split from `Sidebar.test.tsx` rather than appended to it, on the same line the frame
// itself draws: that file asserts what a person can SEE in the column, this one asserts
// what a person can DO to it from outside. Both drive the one composed frame through the
// one harness beside them.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SidebarSectionRegistry } from "../../seats/index.js";
import { INITIAL_SIDEBAR_LAYOUT_STATE } from "./model/sidebar-layout-record.js";
import { SidebarModel } from "./model/sidebar-model.js";
import { disclosures, filterField, renderSidebar } from "./Sidebar.test-support.js";

describe("Sidebar — the column collapses to a rail a pointer can recover", () => {
  it("collapses from the column's own control, so the palette is not the only way", () => {
    const { sidebar, column } = renderSidebar();
    const collapse = sidebar.querySelector(".meridian-sidebar__collapse");
    expect(collapse).not.toBeNull();
    act(() => {
      (collapse as HTMLButtonElement).click();
    });
    expect(column().classList.contains("meridian-sidebar--collapsed")).toBe(true);
  });

  it("expands again from the collapsed rail, which is what keeps it reachable", () => {
    const collapsed = new SidebarModel();
    collapsed.setColumnCollapsed(true);
    const { column } = renderSidebar(new SidebarSectionRegistry(), collapsed);
    const expand = column().querySelector(".meridian-sidebar__expand");
    expect(expand?.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      (expand as HTMLButtonElement).click();
    });
    expect(column().classList.contains("meridian-sidebar--collapsed")).toBe(false);
  });

  it("reaches the same two acts through the palette's seat", () => {
    const { model, seat, column } = renderSidebar();
    act(() => {
      seat.perform("toggleSidebarCollapsed");
    });
    expect(model.snapshot.state.isCollapsed).toBe(true);
    act(() => {
      seat.perform("focusSidebarFilter");
    });
    // The filter act opens the column first, because a field on a rail is a field
    // nobody can type in.
    expect(model.snapshot.state.isCollapsed).toBe(false);
    expect(document.activeElement).toBe(filterField(column()));
  });
});

describe("Sidebar — the restore, rendered rather than swallowed", () => {
  it("renders a record this build cannot read as a refusal rather than crashing", () => {
    const model = new SidebarModel();
    const { sidebar } = renderSidebar(new SidebarSectionRegistry(), model);
    act(() => {
      model.restore({
        state: INITIAL_SIDEBAR_LAYOUT_STATE,
        refusals: [
          {
            origin: "sidebar-layout",
            code: "snapshot-version-unknown",
            detail: "The saved sidebar was written by a different version of the console.",
          },
        ],
      });
    });
    expect(sidebar.querySelector(".meridian-sidebar__refusals")?.textContent).toContain(
      "different version",
    );
  });

  it("announces a settled sidebar once, and not again on a later render", () => {
    const model = new SidebarModel();
    const { announcements, sidebar } = renderSidebar(new SidebarSectionRegistry(), model);
    act(() => {
      model.restore({
        state: { ...INITIAL_SIDEBAR_LAYOUT_STATE, collapsedSectionIds: new Set(["channels"]) },
        refusals: [],
      });
    });
    expect(announcements.textContent).toContain("Goal");
    const announced = announcements.textContent;
    act(() => {
      disclosures(sidebar)[0]?.click();
    });
    expect(announcements.textContent).toBe(announced);
  });

  it("says nothing where the settled sidebar reports nothing a person cannot see", () => {
    // A sidebar that restored nothing and opened nothing is a sidebar a person is
    // looking at, and the window has one polite lane.
    const model = new SidebarModel();
    const { announcements } = renderSidebar(new SidebarSectionRegistry(), model);
    act(() => {
      model.restore({ state: INITIAL_SIDEBAR_LAYOUT_STATE, refusals: [] });
    });
    expect(announcements.textContent).toBe("");
  });
});
