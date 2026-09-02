// The sidebar frame: every section present, none of them opened by the frame, and
// an unfilled one saying so rather than reading as empty.
//
// The set is driven from `SIDEBAR_SECTION_IDS` rather than listed here, for the
// reason that tuple exists: the order IS the sidebar's order, so a test carrying
// its own copy would agree with a reordered sidebar and disagree with the spec.
//
// The seat registry is module-scope, so every case that fills a section unfills it
// afterwards — a leaked section would make the next case's "not built yet" claim
// pass or fail on test ORDER, which is the one way an assertion about an absence
// can be true for the wrong reason.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../../store/index.js";
import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { COMPOSER_SCENARIO } from "../../bridge/scenarios/composer.js";
import { SIDEBAR_SECTION_IDS, sidebarSectionRegistry } from "../seats/index.js";
import { Sidebar } from "./Sidebar.js";

const SECTION_OWNER = "sidebar-frame-test";

function renderSidebar(): HTMLElement {
  const bridge: ConsoleBridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  const { container } = render(
    <Sidebar
      sessionStore={new SessionStore({ sessionId: "session-sidebar" })}
      bridge={bridge}
      openPane={() => undefined}
    />,
  );
  const sidebar = container.querySelector(".meridian-sidebar");
  if (!(sidebar instanceof HTMLElement)) {
    throw new Error("the sidebar rendered no nav element");
  }
  return sidebar;
}

function disclosures(sidebar: HTMLElement): readonly HTMLButtonElement[] {
  return [...sidebar.querySelectorAll("button.meridian-sidebar__disclosure")].filter(
    (button): button is HTMLButtonElement => button instanceof HTMLButtonElement,
  );
}

afterEach(() => {
  for (const id of SIDEBAR_SECTION_IDS) {
    sidebarSectionRegistry.unregister(id);
  }
});

describe("Sidebar — the sections host", () => {
  it("renders one disclosure per declared section, in declaration order", () => {
    const sidebar = renderSidebar();
    const labels = disclosures(sidebar).map((button) => button.textContent);
    expect(labels).toHaveLength(SIDEBAR_SECTION_IDS.length);
    // Declaration order is render order, so the runs section — third in the tuple
    // — is third on screen.
    expect(labels[2]).toContain("Runs");
    expect(labels[0]).toContain("Channels");
  });

  it("starts every section collapsed and its body hidden", () => {
    // Density: "collapsed by default; a section opens itself only for amber or
    // red". No section can carry attention yet, because no section has a read.
    const sidebar = renderSidebar();
    for (const button of disclosures(sidebar)) {
      expect(button.getAttribute("aria-expanded")).toBe("false");
      const bodyId = button.getAttribute("aria-controls");
      expect(bodyId).not.toBeNull();
      expect(sidebar.querySelector(`#${String(bodyId)}`)?.hasAttribute("hidden")).toBe(true);
    }
  });

  it("opens and re-collapses the section a person activates, and only that one", () => {
    const sidebar = renderSidebar();
    const [first, second] = disclosures(sidebar);
    // `act` because the disclosure sets React state: without it the assertion
    // reads the DOM before the re-render and the case fails for the wrong reason.
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
    const sidebar = renderSidebar();
    const expanded = disclosures(sidebar).map((button) => button.getAttribute("aria-expanded"));
    expect(new Set(expanded)).toStrictEqual(new Set(["false"]));
  });
});

describe("Sidebar — an unfilled section is reserved, not empty", () => {
  it("says the section has not been built rather than rendering nothing", () => {
    const sidebar = renderSidebar();
    const firstBody = sidebar.querySelector(".meridian-sidebar__body");
    expect(firstBody?.textContent).toContain("has not been built yet");
    // `not-checked`, never `empty`: nothing was asked, so nothing may read as an
    // answered read that came back with no rows.
    expect(sidebar.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("renders the owning family's body once a section is filled", () => {
    sidebarSectionRegistry.register({
      id: "runs",
      owner: SECTION_OWNER,
      render: (context) => <p>runs body, open: {String(context.isOpen)}</p>,
    });
    const sidebar = renderSidebar();
    expect(sidebar.textContent).toContain("runs body, open: false");
    // The frame decides openness, not the section: the context it was handed says
    // `false` because the frame has this section collapsed.
    expect(sidebar.textContent).not.toContain("runs body, open: true");
  });

  it("negative control: with the seat released, the body is gone again", () => {
    // Without this, the case above would pass over a frame that rendered a body it
    // had cached, and the `afterEach` cleanup would be unverified.
    sidebarSectionRegistry.register({
      id: "runs",
      owner: SECTION_OWNER,
      render: () => <p>runs body, open: false</p>,
    });
    expect(renderSidebar().textContent).toContain("runs body, open: false");
    sidebarSectionRegistry.unregister("runs");
    expect(renderSidebar().textContent).not.toContain("runs body, open: false");
  });
});
