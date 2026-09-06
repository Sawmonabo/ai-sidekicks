// The sidebar frame: every section present, none of them opened by the frame, an
// unfilled one saying so rather than reading as empty, and the four things the
// frame itself owns — the filter, the attention rule, the width, and the refusal.
//
// The section set is driven from `SIDEBAR_SECTION_IDS` rather than listed here,
// for the reason that tuple exists: the order IS the sidebar's order, so a test
// carrying its own copy would agree with a reordered sidebar and disagree with the
// spec.
//
// EVERY CASE COMPOSES ITS OWN REGISTRY. The frame takes one as a prop for exactly
// this reason — a module-scope registry would make an assertion about an absence
// true or false on test ORDER, which is the one way a claim about a hole can pass
// for the wrong reason.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionStore } from "../../store/index.js";
import { MemoryPersistenceAdapter, UiStateStore } from "../../persistence/index.js";
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { COMPOSER_SCENARIO } from "../../bridge/scenarios/composer.js";
import {
  SIDEBAR_SECTION_IDS,
  SidebarSectionRegistry,
  type SidebarSectionContext,
} from "../../seats/index.js";
import { SIDEBAR_MIN_WIDTH_PX } from "../../core/index.js";
import { Sidebar } from "./Sidebar.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";

const SECTION_OWNER = "sidebar-frame-test";

interface RenderedSidebar {
  readonly sidebar: HTMLElement;
  readonly registry: SidebarSectionRegistry;
}

function renderSidebar(
  registry: SidebarSectionRegistry = new SidebarSectionRegistry(),
  uiStateStore?: UiStateStore,
): RenderedSidebar {
  const bridge: ConsoleBridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  const { container } = render(
    <Sidebar
      sessionStore={new SessionStore({ sessionId: "session-sidebar" })}
      bridge={bridge}
      openPane={() => undefined}
      sectionRegistry={registry}
      {...(uiStateStore === undefined ? {} : { uiStateStore })}
    />,
  );
  const sidebar = container.querySelector(".meridian-sidebar");
  if (!(sidebar instanceof HTMLElement)) {
    throw new Error("the sidebar rendered no nav element");
  }
  return { sidebar, registry };
}

function disclosures(sidebar: HTMLElement): readonly HTMLButtonElement[] {
  return [...sidebar.querySelectorAll("button.meridian-sidebar__disclosure")].filter(
    (button): button is HTMLButtonElement => button instanceof HTMLButtonElement,
  );
}

function resizeSeparator(sidebar: HTMLElement): HTMLElement {
  const separator = sidebar.querySelector('[role="separator"]');
  if (!(separator instanceof HTMLElement)) {
    throw new Error("the sidebar rendered no width separator");
  }
  return separator;
}

function filterField(sidebar: HTMLElement): HTMLInputElement {
  const field = sidebar.querySelector(".meridian-sidebar__filter-field");
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("the sidebar rendered no filter field");
  }
  return field;
}

describe("Sidebar — the sections host", () => {
  it("renders one disclosure per declared section, in declaration order", () => {
    const { sidebar } = renderSidebar();
    const labels = disclosures(sidebar).map((button) => button.textContent);
    expect(labels).toHaveLength(SIDEBAR_SECTION_IDS.length);
    // Declaration order is render order, so each label sits at its own id's index
    // in the seat's tuple. Read off the tuple rather than pinned at two positions:
    // a pinned index says nothing about the sections either side of it, and it goes
    // stale silently the day the seat gains one — which is how `goal` and
    // `approvals` arrived.
    expect(labels[SIDEBAR_SECTION_IDS.indexOf("goal")]).toContain("Goal");
    expect(labels[SIDEBAR_SECTION_IDS.indexOf("channels")]).toContain("Channels");
    expect(labels[SIDEBAR_SECTION_IDS.indexOf("runs")]).toContain("Runs");
    expect(labels[SIDEBAR_SECTION_IDS.indexOf("members")]).toContain("Members");
  });

  it("starts every section collapsed and its body hidden", () => {
    // Density: "collapsed by default; a section opens itself only for amber or
    // red". No section can carry attention yet, because no section has reported.
    const { sidebar } = renderSidebar();
    for (const button of disclosures(sidebar)) {
      expect(button.getAttribute("aria-expanded")).toBe("false");
      const bodyId = button.getAttribute("aria-controls");
      expect(bodyId).not.toBeNull();
      expect(sidebar.querySelector(`#${String(bodyId)}`)?.hasAttribute("hidden")).toBe(true);
    }
  });

  it("opens and re-collapses the section a person activates, and only that one", () => {
    const { sidebar } = renderSidebar();
    const [first, second] = disclosures(sidebar);
    // `act` because the disclosure moves model state React renders from: without
    // it the assertion reads the DOM before the re-render and fails for the wrong
    // reason.
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

  it("negative control: activating nothing leaves every section shut", () => {
    // The case above would pass over a frame that opened a section on render,
    // because it only ever asserts the state AFTER a click.
    const { sidebar } = renderSidebar();
    const expanded = disclosures(sidebar).map((button) => button.getAttribute("aria-expanded"));
    expect(new Set(expanded)).toStrictEqual(new Set(["false"]));
  });
});

describe("Sidebar — an unfilled section is reserved, not empty", () => {
  it("says the section has not been built rather than rendering nothing", () => {
    const { sidebar } = renderSidebar();
    const firstBody = sidebar.querySelector(".meridian-sidebar__body");
    expect(firstBody?.textContent).toContain("has not been built yet");
    // `not-checked`, never `empty`: nothing was asked, so nothing may read as an
    // answered read that came back with no rows.
    expect(sidebar.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("renders the owning family's body once a section is filled", () => {
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "runs",
      owner: SECTION_OWNER,
      render: (context) => <p>runs body, open: {String(context.isOpen)}</p>,
    });
    const { sidebar } = renderSidebar(registry);
    expect(sidebar.textContent).toContain("runs body, open: false");
    // The frame decides openness, not the section: the context it was handed says
    // `false` because the frame has this section collapsed.
    expect(sidebar.textContent).not.toContain("runs body, open: true");
  });

  it("negative control: with the seat released, the body is gone again", () => {
    // Without this, the case above would pass over a frame that rendered a body
    // it had cached.
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "runs",
      owner: SECTION_OWNER,
      render: () => <p>runs body, open: false</p>,
    });
    expect(renderSidebar(registry).sidebar.textContent).toContain("runs body, open: false");
    registry.unregister("runs");
    expect(renderSidebar(registry).sidebar.textContent).not.toContain("runs body, open: false");
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
    // Composed from the seat's own length rather than written out, so a section
    // added there does not turn this into a claim about a shorter sidebar.
    expect(expanded).toStrictEqual(["true", ...SIDEBAR_SECTION_IDS.slice(1).map(() => "false")]);
  });
});

describe("Sidebar — a section that reports attention opens itself", () => {
  it("opens the section and marks it, on the section's own report", () => {
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "runs",
      owner: SECTION_OWNER,
      render: (context: SidebarSectionContext) => {
        // Reported during render rather than from an effect only because this
        // stand-in has no read to hang one on; the seat's own contract asks a
        // real section to report from an effect.
        context.reportAttention?.("amber");
        return <p>runs body</p>;
      },
    });
    const { sidebar } = renderSidebar(registry);
    const runsDisclosure = disclosures(sidebar)[2];
    expect(runsDisclosure?.getAttribute("aria-expanded")).toBe("true");
    expect(sidebar.querySelector(".meridian-sidebar__attention--amber")).not.toBeNull();
  });

  it("negative control: a section reporting calm neither opens nor marks", () => {
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "runs",
      owner: SECTION_OWNER,
      render: (context: SidebarSectionContext) => {
        context.reportAttention?.("calm");
        return <p>runs body</p>;
      },
    });
    const { sidebar } = renderSidebar(registry);
    expect(disclosures(sidebar)[2]?.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.querySelector(".meridian-sidebar__attention")).toBeNull();
  });
});

describe("Sidebar — the width separator", () => {
  it("offers a keyboard-driveable separator that reports the width it is at", async () => {
    const uiStateStore = new UiStateStore({ adapter: new MemoryPersistenceAdapter() });
    const { sidebar } = renderSidebar(new SidebarSectionRegistry(), uiStateStore);
    const separator = resizeSeparator(sidebar);
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.getAttribute("aria-valuemin")).toBe(String(SIDEBAR_MIN_WIDTH_PX));

    // `Home` goes to the narrowest bound, which is what `aria-valuemin` promises
    // a keyboard user. `findBy`-style waiting rather than a bare assertion
    // because the durable restore is in flight on the first frames, and the
    // width the person chose has to survive it landing.
    await act(async () => {
      fireEvent.keyDown(separator, { key: "Home" });
      await crossMacrotaskBoundary();
    });
    await vi.waitFor(() => {
      expect(separator.getAttribute("aria-valuenow")).toBe(String(SIDEBAR_MIN_WIDTH_PX));
    });
    expect(sidebar.getAttribute("style")).toContain(`${String(SIDEBAR_MIN_WIDTH_PX)}px`);
  });
});
