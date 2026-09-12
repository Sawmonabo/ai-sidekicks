// The sidebar frame: every section present, none of them opened by the frame, an
// unfilled one saying so rather than reading as empty, and the five things the frame
// itself owns — the filter, the attention rule, the collapse, the refusals, and what it
// announces once.
//
// The section set is driven from `SIDEBAR_SECTION_IDS` rather than listed here, for the
// reason that tuple exists: the order IS the sidebar's order, so a test carrying its own
// copy would agree with a reordered sidebar and disagree with the design.
//
// EVERY CASE COMPOSES ITS OWN REGISTRY. The frame takes one as a prop for exactly this
// reason — a module-scope registry would make an assertion about an absence true or
// false on test ORDER, which is the one way a claim about a hole can pass for the wrong
// reason.
//
// AND EVERY CASE OWNS ITS OWN MODEL, through the same subscription the workspace makes.
// The width and the collapse belong to the workspace's split, so the frame is handed a
// model rather than minting one, and a host that skipped the subscription would render
// one frame and never again.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  SIDEBAR_SECTION_IDS,
  SidebarSectionRegistry,
  type SidebarSectionContext,
} from "../../seats/index.js";
import { SidebarModel } from "./model/sidebar-model.js";
import { SECTION_OWNER, disclosures, filterField, renderSidebar } from "./Sidebar.test-support.js";

describe("Sidebar — the sections host", () => {
  it("renders one disclosure per declared section, in declaration order", () => {
    const { sidebar } = renderSidebar();
    const labels = disclosures(sidebar).map((button) => button.textContent);
    expect(labels).toHaveLength(SIDEBAR_SECTION_IDS.length);
    // Declaration order is render order, so each label sits at its own id's index in
    // the seat's tuple. Read off the tuple rather than pinned at two positions: a
    // pinned index says nothing about the sections either side of it, and it goes
    // stale silently the day the seat gains one.
    expect(labels[SIDEBAR_SECTION_IDS.indexOf("goal")]).toContain("Goal");
    expect(labels[SIDEBAR_SECTION_IDS.indexOf("channels")]).toContain("Channels");
    expect(labels[SIDEBAR_SECTION_IDS.indexOf("runs")]).toContain("Runs");
    expect(labels[SIDEBAR_SECTION_IDS.indexOf("artifacts")]).toContain("Artifacts");
  });

  it("starts every section collapsed, with no body mounted at all", () => {
    // Density: collapsed by default, a section opens itself only for attention. No
    // section can carry attention yet, because no section has answered.
    const { sidebar } = renderSidebar();
    for (const button of disclosures(sidebar)) {
      expect(button.getAttribute("aria-expanded")).toBe("false");
      const bodyId = button.getAttribute("aria-controls");
      expect(bodyId).not.toBeNull();
      // NOT MOUNTED, rather than mounted and hidden: a section body is what starts
      // that section's read, and a hidden one would run every read to show none.
      expect(sidebar.querySelector(`#${String(bodyId)}`)).toBeNull();
    }
  });

  it("opens and re-collapses the section a person activates, and only that one", () => {
    const { sidebar } = renderSidebar();
    const [first, second] = disclosures(sidebar);
    // `act` because the disclosure moves model state React renders from: without it
    // the assertion reads the DOM before the re-render and fails for the wrong reason.
    act(() => {
      first?.click();
    });
    expect(first?.getAttribute("aria-expanded")).toBe("true");
    expect(second?.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      first?.click();
    });
    expect(first?.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a second section beside the first, rather than closing it", () => {
    // The inverted set read through the frame: many sections open at once is what the
    // grammar asks for, and an accordion would take the first back down here.
    const { sidebar } = renderSidebar();
    const [first, second] = disclosures(sidebar);
    act(() => {
      first?.click();
    });
    act(() => {
      second?.click();
    });
    expect(first?.getAttribute("aria-expanded")).toBe("true");
    expect(second?.getAttribute("aria-expanded")).toBe("true");
  });

  it("negative control: activating nothing leaves every section shut", () => {
    // The cases above would pass over a frame that opened a section on render, because
    // they only ever assert the state AFTER a click.
    const { sidebar } = renderSidebar();
    const expanded = disclosures(sidebar).map((button) => button.getAttribute("aria-expanded"));
    expect(new Set(expanded)).toStrictEqual(new Set(["false"]));
  });
});

describe("Sidebar — an unfilled section is reserved, not empty", () => {
  it("says the section has not been built rather than rendering nothing", () => {
    const { sidebar } = renderSidebar();
    act(() => {
      disclosures(sidebar)[0]?.click();
    });
    const firstBody = sidebar.querySelector(".meridian-sidebar__body");
    expect(firstBody?.textContent).toContain("has not been built yet");
    // `not-checked`, never `empty`: nothing was asked, so nothing may read as an
    // answered read that came back with no rows.
    expect(sidebar.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("renders the owning family's body once a section is filled and opened", () => {
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "runs",
      owner: SECTION_OWNER,
      render: (context) => <p>runs body, open: {String(context.isOpen)}</p>,
    });
    const { sidebar } = renderSidebar(registry);
    expect(sidebar.textContent).not.toContain("runs body");
    act(() => {
      disclosures(sidebar)[SIDEBAR_SECTION_IDS.indexOf("runs")]?.click();
    });
    // The frame decides openness, not the section, and a mounted body is by
    // construction an open one.
    expect(sidebar.textContent).toContain("runs body, open: true");
  });

  it("negative control: with the seat released, the body is gone again", () => {
    // Without this, the case above would pass over a frame that rendered a body it had
    // cached.
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "runs",
      owner: SECTION_OWNER,
      render: () => <p>runs body</p>,
    });
    const opened = new SidebarModel();
    opened.setSectionCollapsed("runs", false);
    expect(renderSidebar(registry, opened).sidebar.textContent).toContain("runs body");
    registry.unregister("runs");
    const second = new SidebarModel();
    second.setSectionCollapsed("runs", false);
    expect(renderSidebar(registry, second).sidebar.textContent).not.toContain("runs body");
  });

  it("negative control: a body registered under one id does not render under another", () => {
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "channels",
      owner: SECTION_OWNER,
      render: () => <p>channels body</p>,
    });
    const model = new SidebarModel();
    model.setSectionCollapsed("runs", false);
    const { sidebar } = renderSidebar(registry, model);
    expect(sidebar.textContent).not.toContain("channels body");
  });
});

describe("Sidebar — the filter is one field over every section", () => {
  it("opens every section while filtering and hands each its query", () => {
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "runs",
      owner: SECTION_OWNER,
      render: (context) => <p>query: {context.filterQuery ?? "<absent>"}</p>,
    });
    const { sidebar } = renderSidebar(registry);
    act(() => {
      fireEvent.change(filterField(sidebar), { target: { value: "deploy" } });
    });
    const expanded = disclosures(sidebar).map((button) => button.getAttribute("aria-expanded"));
    expect(new Set(expanded)).toStrictEqual(new Set(["true"]));
    expect(sidebar.textContent).toContain("query: deploy");
  });

  it("rolls the shape back exactly when the filter is cleared", () => {
    const { sidebar } = renderSidebar();
    const [first] = disclosures(sidebar);
    act(() => {
      first?.click();
    });
    act(() => {
      fireEvent.change(filterField(sidebar), { target: { value: "x" } });
    });
    act(() => {
      fireEvent.change(filterField(sidebar), { target: { value: "" } });
    });
    const expanded = disclosures(sidebar).map((button) => button.getAttribute("aria-expanded"));
    // Exactly the one the person opened, and nothing the filter opened on the way.
    // Composed from the seat's own length rather than written out, so a section added
    // there does not turn this into a claim about a shorter sidebar.
    expect(expanded).toStrictEqual(["true", ...SIDEBAR_SECTION_IDS.slice(1).map(() => "false")]);
  });
});

describe("Sidebar — a section that is calling opens itself", () => {
  it("opens the section and marks it, on the section's own reading", () => {
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "runs",
      owner: SECTION_OWNER,
      render: () => <p>runs body</p>,
      attention: () => "attention",
    });
    const { sidebar } = renderSidebar(registry);
    const runsDisclosure = disclosures(sidebar)[SIDEBAR_SECTION_IDS.indexOf("runs")];
    expect(runsDisclosure?.getAttribute("aria-expanded")).toBe("true");
    expect(runsDisclosure?.getAttribute("data-attention")).toBe("attention");
    // And the words, because a tint is not an announcement.
    expect(runsDisclosure?.textContent).toContain("needs attention");
  });

  it("reads a collapsed section's rollup, which is the whole point of the pull", () => {
    // The push form could not do this: a collapsed section is not mounted, so a section
    // in trouble could never report and the rule that opens it could never fire.
    let renders = 0;
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "repos",
      owner: SECTION_OWNER,
      render: () => {
        renders += 1;
        return <p>repos body</p>;
      },
      attention: () => "failure",
    });
    const { sidebar } = renderSidebar(registry);
    const reposDisclosure = disclosures(sidebar)[SIDEBAR_SECTION_IDS.indexOf("repos")];
    expect(reposDisclosure?.getAttribute("data-attention")).toBe("failure");
    // It was read while shut, and opened because of what it said.
    expect(reposDisclosure?.getAttribute("aria-expanded")).toBe("true");
    expect(renders).toBeGreaterThan(0);
  });

  it("negative control: a section answering nothing neither opens nor marks", () => {
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "runs",
      owner: SECTION_OWNER,
      render: (context: SidebarSectionContext) => <p>runs body {String(context.isOpen)}</p>,
      attention: () => undefined,
    });
    const { sidebar } = renderSidebar(registry);
    const runsDisclosure = disclosures(sidebar)[SIDEBAR_SECTION_IDS.indexOf("runs")];
    expect(runsDisclosure?.getAttribute("aria-expanded")).toBe("false");
    expect(runsDisclosure?.hasAttribute("data-attention")).toBe(false);
  });

  it("negative control: a section with no reader at all is left alone", () => {
    // Which is not the same claim as answering nothing: a section with no projection to
    // answer from omits the reader entirely.
    const registry = new SidebarSectionRegistry();
    registry.register({ id: "runs", owner: SECTION_OWNER, render: () => <p>runs body</p> });
    const { sidebar } = renderSidebar(registry);
    expect(
      disclosures(sidebar)[SIDEBAR_SECTION_IDS.indexOf("runs")]?.getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
