// Every control inside the window's drag regions is cut out of them, so pressing one presses it
// and never drags or zooms the window. The rail and the session header are drag regions, and
// Chromium hands `app-region` down to every descendant, so a control no rule cuts out computes
// `drag` and the system takes its press. A popup drawn over a drag region from elsewhere in the
// document is caught by its box: a press there reaches the system's drag first unless the popup
// is cut out too.
//
// Read in Chromium's own cascade, which reports `app-region` through `getComputedStyle`; happy-dom
// has neither the property nor layout. The negative control plants a bare button in the rail.

import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { renderAppSettled } from "../helpers/app/harness.js";
import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";

/** Everything a press acts on: native controls, focusable elements and the roles a click drives. */
const PRESSABLE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[role='button']",
  "[role='menuitem']",
  "[role='tab']",
  "[role='link']",
  "[role='switch']",
  "[role='checkbox']",
  "[tabindex]:not([tabindex='-1'])",
  "[draggable='true']",
].join(", ");

/** What one sweep of a window found. */
interface DragRegionSweep {
  /** How many elements compute `drag` at the top of a region; zero means no sheet reached them. */
  readonly regionCount: number;
  /** How many pressable elements sit inside a region or over one. */
  readonly controlCount: number;
  /** The accessible name of each pressable element there that is not cut out. */
  readonly offenders: readonly string[];
}

beforeEach(() => {
  document.location.hash = "";
});

afterEach(() => {
  cleanup();
});

describe("browser — the window's drag regions", () => {
  it("cuts every control in the rail and the session header out of the drag region", async () => {
    const appWindow = await openSessionScreen();

    const sweep = sweepDragRegions(appWindow.document);

    expect(sweep.regionCount, "no element computes `app-region: drag`").toBeGreaterThanOrEqual(2);
    expect(sweep.controlCount, "the drag regions hold no control to check").toBeGreaterThan(0);
    expect(sweep.offenders, "these controls drag the window instead of taking a press").toEqual([]);
  });

  it("negative control: names a button in the rail and one drawn over the header", async () => {
    const appWindow = await openSessionScreen();
    const windowDocument = appWindow.document;
    const rail = windowDocument.querySelector(".meridian-rail");
    const header = windowDocument.querySelector(".meridian-session-header");
    expect(rail).not.toBeNull();
    expect(header).not.toBeNull();
    const inRail = windowDocument.createElement("button");
    inRail.setAttribute("aria-label", "Planted in the rail");
    (rail as Element).append(inRail);
    // Drawn over the header from outside it, as a popup portaled to the body is.
    const headerBox = (header as Element).getBoundingClientRect();
    const overHeader = windowDocument.createElement("button");
    overHeader.setAttribute("aria-label", "Planted over the header");
    overHeader.style.cssText =
      `position: fixed; left: ${String(headerBox.right - 40)}px; ` +
      `top: ${String(headerBox.top)}px; width: 32px; height: 16px;`;
    windowDocument.body.append(overHeader);
    try {
      expect(sweepDragRegions(windowDocument).offenders).toEqual([
        "Planted in the rail",
        "Planted over the header",
      ]);
    } finally {
      inRail.remove();
      overHeader.remove();
    }
  });
});

/** Mounts the app on the first-run scenario and opens its session, header and all. */
async function openSessionScreen(): Promise<Window> {
  const appWindow = await renderAppSettled(FIRST_RUN_SCENARIO.id);
  await act(async () => {
    appWindow.location.hash = formatRoute({
      kind: "session",
      sessionId: FIRST_RUN_SCENARIO.sessionId,
    });
    await crossMacrotaskBoundary();
  });
  await act(async () => {
    await expect
      .poll(() => appWindow.document.querySelector(".meridian-session-header"))
      .not.toBeNull();
  });
  return appWindow;
}

/**
 * Finds every pressable element inside an element computing `app-region: drag`, or drawn over
 * one, and names each that does not compute `no-drag`.
 */
function sweepDragRegions(windowDocument: Document): DragRegionSweep {
  const view = windowDocument.defaultView;
  if (view === null) {
    throw new Error("The window's document has no window.");
  }
  const appRegionOf = (element: Element): string =>
    view.getComputedStyle(element).getPropertyValue("app-region");
  const regions = [...windowDocument.querySelectorAll("*")].filter(
    (element) =>
      appRegionOf(element) === "drag" &&
      (element.parentElement === null || appRegionOf(element.parentElement) !== "drag"),
  );
  const regionBoxes = regions.map((region) => region.getBoundingClientRect());
  const controls = [...windowDocument.querySelectorAll(PRESSABLE_SELECTOR)].filter(
    (control) =>
      regions.some((region) => region.contains(control)) ||
      regionBoxes.some((box) => boxesOverlap(box, control.getBoundingClientRect())),
  );
  return {
    regionCount: regions.length,
    controlCount: controls.length,
    offenders: controls
      .filter((control) => appRegionOf(control) !== "no-drag")
      .map((control) => accessibleNameOf(control)),
  };
}

/** Whether two boxes share any area; boxes that only touch along an edge do not. */
function boxesOverlap(first: DOMRect, second: DOMRect): boolean {
  return (
    first.left < second.right &&
    second.left < first.right &&
    first.top < second.bottom &&
    second.top < first.bottom
  );
}

/** The name a failure reports a control by: its label, its title, its text, or its markup. */
function accessibleNameOf(control: Element): string {
  const labelledBy = control.getAttribute("aria-labelledby");
  const labelText =
    labelledBy === null
      ? undefined
      : labelledBy
          .split(/\s+/)
          .map((id) => control.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
          .join(" ")
          .trim();
  const candidates = [
    control.getAttribute("aria-label"),
    labelText,
    control.getAttribute("title"),
    control.textContent?.trim(),
  ];
  return (
    candidates.find((name) => name !== null && name !== undefined && name !== "") ??
    control.outerHTML
  );
}
