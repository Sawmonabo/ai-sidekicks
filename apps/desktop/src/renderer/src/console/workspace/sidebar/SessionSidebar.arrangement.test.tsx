// The sidebar's ARRANGEMENT: collapse, width, the keyboard, and what survives the
// window closing.
//
// Split from `SessionSidebar.test.tsx`, which is about which sections exist and which
// one is open. The failure here is a different quiet one: a choice that never survives
// a restart makes the sidebar forget what a person was watching, and a width that
// saves before the restore lands files the opening default over the record it was
// still reading.

import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PERSISTED_VALUE_CLASSES } from "../../persistence/value-classes.js";
import { SIDEBAR_SECTION_IDS } from "../../seats/index.js";
import {
  SIDEBAR_LAYOUT_RECORD_KEY,
  SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
  SIDEBAR_SECTION_LABELS,
  SIDEBAR_SNAPSHOT_HEADER_KEY,
} from "./sidebar-model.js";
import {
  SESSION_ID,
  headerFor,
  headers,
  press,
  renderSidebar,
  settled,
} from "./SessionSidebar.test-support.js";
import { memoryStore } from "../Workspace.test-support.js";

describe("the sidebar — collapse, width, and what is kept", () => {
  it("restores collapsed, at the width it was saved with", async () => {
    const store = memoryStore();
    const written = await store.write(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY, "layout", {
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: {
        version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
        widthPercent: 31,
        isCollapsed: true,
      },
    });
    expect(written.outcome).toBe("written");

    const rendered = renderSidebar(store);
    await waitFor(() => {
      expect(rendered.container.querySelector(".meridian-sidebar--collapsed")).not.toBeNull();
    });
    // The width travels with the collapse rather than being forgotten by it: expanding
    // puts the sidebar back where the person left it.
    const record = await store.read(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY);
    const header = (record?.value as Record<string, Record<string, unknown>>)[
      SIDEBAR_SNAPSHOT_HEADER_KEY
    ];
    expect(header?.["widthPercent"]).toBe(31);
  });

  it("collapses from the column's own control, so the palette is not the only way", async () => {
    const rendered = renderSidebar();
    await settled(rendered.container);

    act(() => {
      rendered.container.querySelector<HTMLButtonElement>(".meridian-sidebar__collapse")?.click();
    });

    expect(rendered.container.querySelector(".meridian-sidebar--collapsed")).not.toBeNull();
    expect(headers(rendered.container)).toHaveLength(0);
  });

  it("expands again from the collapsed rail, which is what keeps it reachable", async () => {
    const store = memoryStore();
    await store.write(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY, "layout", {
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: {
        version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
        widthPercent: 31,
        isCollapsed: true,
      },
    });
    const rendered = renderSidebar(store);
    await waitFor(() => {
      expect(rendered.container.querySelector(".meridian-sidebar__expand")).not.toBeNull();
    });

    act(() => {
      rendered.container.querySelector<HTMLButtonElement>(".meridian-sidebar__expand")?.click();
    });

    expect(headers(rendered.container)).toHaveLength(SIDEBAR_SECTION_IDS.length);
  });

  it("keeps everything under the `layout` class, adding none of its own", async () => {
    // The negative control that catches a widening: the closed enumeration is asserted
    // BY NAME, so a sidebar that had reached for a class of its own fails here rather
    // than at the chokepoint one release later.
    expect([...PERSISTED_VALUE_CLASSES]).toStrictEqual([
      "layout",
      "scroll-position",
      "selection",
      "pin",
      "expansion",
      "scheme",
      "keybinding",
    ]);
    const store = memoryStore();
    const rendered = renderSidebar(store);
    await settled(rendered.container);
    press(headerFor(rendered.container, "goal"));
    await waitFor(async () => {
      const record = await store.read(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY);
      expect(record?.valueClass).toBe("layout");
    });
  });

  it("renders a record this build cannot read as a refusal rather than crashing", async () => {
    const store = memoryStore();
    await store.write(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY, "layout", {
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: { version: 99, widthPercent: 31, isCollapsed: false },
    });
    const rendered = renderSidebar(store);
    await waitFor(() => {
      expect(
        rendered.container.querySelector('.meridian-sidebar__refusals[role="status"]')?.textContent,
      ).toContain("written by a different version");
    });
    expect(headers(rendered.container)).toHaveLength(SIDEBAR_SECTION_IDS.length);
  });

  it("leaves a value the chokepoint will not take to the chokepoint, rather than storing it", async () => {
    // The other half of the same guarantee, and it is deliberately not the sidebar's
    // to enforce: a value carrying authored content is stopped by the store's own
    // validator, which a development build escalates to a tripwire. The sidebar writes
    // identifiers, so it never reaches this — and it holds no second copy of the rule.
    const store = memoryStore();
    await expect(
      store.write(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY, "layout", {
        [SIDEBAR_SNAPSHOT_HEADER_KEY]: { version: 1, openSectionId: "not an identifier at all" },
      }),
    ).rejects.toThrow(/not identifier-shaped/);
  });
});

describe("the sidebar — the keyboard and what it announces", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("puts every section header in tab order with its state exposed", async () => {
    const rendered = renderSidebar();
    await settled(rendered.container);
    for (const header of headers(rendered.container)) {
      expect(header.tagName).toBe("BUTTON");
      expect(header.getAttribute("aria-expanded")).not.toBeNull();
      expect(header.getAttribute("aria-controls")).not.toBeNull();
      expect(header.hasAttribute("disabled")).toBe(false);
    }
  });

  it("focuses the first header and toggles the collapse through the palette's acts", async () => {
    const rendered = renderSidebar();
    await settled(rendered.container);

    act(() => {
      expect(rendered.commandSeat.perform("focusSidebar").status).toBe("performed");
    });
    expect(document.activeElement).toBe(headers(rendered.container)[0]);

    act(() => {
      rendered.commandSeat.perform("toggleSidebarCollapsed");
    });
    expect(rendered.container.querySelector(".meridian-sidebar--collapsed")).not.toBeNull();
  });

  it("announces a section that came back open once, and not again on a later render", async () => {
    const store = memoryStore();
    await store.write(SESSION_ID, SIDEBAR_LAYOUT_RECORD_KEY, "layout", {
      [SIDEBAR_SNAPSHOT_HEADER_KEY]: {
        version: SIDEBAR_LAYOUT_SNAPSHOT_VERSION,
        widthPercent: 22,
        isCollapsed: false,
        openSectionId: "repos",
      },
    });
    const rendered = renderSidebar(store);
    await waitFor(() => {
      expect(politeText(rendered.container)).toContain(SIDEBAR_SECTION_LABELS["repos"]);
    });
    const announced = politeText(rendered.container);

    press(headerFor(rendered.container, "channels"));

    // The negative control: opening a section re-renders the whole column, and a
    // surface that announced on render would speak again here.
    expect(politeText(rendered.container)).toBe(announced);
  });

  it("says nothing where the settled sidebar reports nothing a person cannot see", async () => {
    // The announcer serialises one polite message at a time, so a sentence nobody
    // needed delays the next one somebody does. A sidebar that restored nothing and
    // opened nothing is a column already on screen.
    const rendered = renderSidebar();
    await settled(rendered.container);
    expect(politeText(rendered.container)).toBe("");
  });
});

function politeText(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}
