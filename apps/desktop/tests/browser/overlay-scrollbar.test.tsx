// Every scroller on screen but the conversation draws its bar over its content, through its own
// window's copy of the overlay scrollbar library, and takes no layout width for it. Measured in
// Chromium on the real app in a short window, where the screens overflow; a plain scroller planted
// beside them is the negative control the sweep must report. A payload whose text changes keeps
// its bar, which React's `textContent` write would delete from a box holding bare text.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import { TRANSCRIPT_STATES_SCENARIO_ID } from "#fixtures/scenarios/transcript-states.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { ArtifactPayloadSection } from "#renderer/features/repos/artifacts/components/ArtifactPayloadSection.js";
import { routeForDestination } from "#renderer/layout/NavigationRail/destinations.js";
import { installOverlayScrollbarLibrary } from "#renderer/lib/overlay-scrollbar-library.js";
import { RAIL_DESTINATIONS } from "#renderer/routing/readers.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { renderAppSettled } from "../helpers/app/harness.js";

/** A window short enough that every screen holds more than it shows. */
const SHORT_WINDOW = { width: 1024, height: 360 };

/** The scrollers that draw no overlay: the conversation, and the terminal's own emulator. */
const SCROLLERS_WITHOUT_OVERLAY = [".meridian-transcript-viewport__scroll-container", ".xterm"];

/** The marker the library puts on the element it scrolls. */
const OVERLAY_VIEWPORT_ATTRIBUTE = "data-overlayscrollbars-viewport";

/** How long a bar may take to start: the library's load plus its window's idle time. */
const OVERLAY_START_TIMEOUT_MS = 5000;

const tierViewport = { width: window.innerWidth, height: window.innerHeight };

/** Every element under `root` that scrolls content it does not show, by its classes. */
function scrollingElements(root: Document): HTMLElement[] {
  const view = root.defaultView;
  if (view === null) {
    throw new Error("the window under test has no view");
  }
  return Array.from(root.body.querySelectorAll<HTMLElement>("*")).filter((element) => {
    if (SCROLLERS_WITHOUT_OVERLAY.some((selector) => element.closest(selector) !== null)) {
      return false;
    }
    const style = view.getComputedStyle(element);
    const scrollsInline =
      isScrollingOverflow(style.overflowX) && element.scrollWidth > element.clientWidth;
    const scrollsBlock =
      isScrollingOverflow(style.overflowY) && element.scrollHeight > element.clientHeight;
    return scrollsInline || scrollsBlock;
  });
}

/**
 * One line per scroller that draws the platform's bar: one with no overlay, or one whose bar
 * takes layout width beside its borders.
 */
function scrollersDrawingTheirOwnBar(root: Document): string[] {
  const view = root.defaultView;
  if (view === null) {
    throw new Error("the window under test has no view");
  }
  return scrollingElements(root).flatMap((element) => {
    const style = view.getComputedStyle(element);
    const barInline =
      element.offsetWidth -
      element.clientWidth -
      Number.parseFloat(style.borderLeftWidth) -
      Number.parseFloat(style.borderRightWidth);
    const barBlock =
      element.offsetHeight -
      element.clientHeight -
      Number.parseFloat(style.borderTopWidth) -
      Number.parseFloat(style.borderBottomWidth);
    const hasOverlay = element.hasAttribute(OVERLAY_VIEWPORT_ATTRIBUTE);
    if (hasOverlay && Math.round(barInline) === 0 && Math.round(barBlock) === 0) {
      return [];
    }
    return [
      `${describeElement(element)} (overlay ${String(hasOverlay)}, bar ${barInline}×${barBlock})`,
    ];
  });
}

function isScrollingOverflow(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll";
}

function describeElement(element: Element): string {
  return `${element.localName}${Array.from(element.classList, (name) => `.${name}`).join("")}`;
}

/** Wait inside `act` until `assertion` holds, so what the app settles meanwhile is flushed. */
async function untilInsideAct(assertion: () => PromiseLike<void>): Promise<void> {
  await act(async () => {
    await assertion();
  });
}

beforeEach(async () => {
  document.location.hash = "";
  await page.viewport(SHORT_WINDOW.width, SHORT_WINDOW.height);
});

afterEach(async () => {
  cleanup();
  await page.viewport(tierViewport.width, tierViewport.height);
});

describe("the overlay scrollbar", () => {
  // Every rail destination, so a new destination is swept the day it is declared.
  const routes = RAIL_DESTINATIONS.map((destination) =>
    formatRoute(routeForDestination(destination)),
  );
  for (const route of routes) {
    it(`draws every scroller's bar over its content at ${route}`, async () => {
      document.location.hash = route;
      const appWindow = await renderAppSettled(TRANSCRIPT_STATES_SCENARIO_ID);
      expect(appWindow.innerHeight).toBe(SHORT_WINDOW.height);

      // Something on the screen scrolls, or the sweep below would pass on nothing.
      expect(scrollingElements(appWindow.document).length).toBeGreaterThan(0);
      await untilInsideAct(() =>
        expect
          .poll(() => scrollersDrawingTheirOwnBar(appWindow.document), {
            timeout: OVERLAY_START_TIMEOUT_MS,
          })
          .toStrictEqual([]),
      );

      // Negative control: a plain scroller in the same window is reported.
      const plainScroller = appWindow.document.createElement("div");
      plainScroller.className = "plain-scroller";
      plainScroller.style.cssText = "overflow: auto; block-size: 4rem";
      const tallContent = appWindow.document.createElement("div");
      tallContent.style.blockSize = "20rem";
      plainScroller.append(tallContent);
      appWindow.document.body.append(plainScroller);
      expect(scrollersDrawingTheirOwnBar(appWindow.document)).toStrictEqual([
        expect.stringContaining("div.plain-scroller (overlay false"),
      ]);
    });
  }

  it("keeps a payload's bar when its text changes", async () => {
    installMeridianTokens(document);
    installOverlayScrollbarLibrary(document);
    const payload = (text: string): React.JSX.Element => (
      <ArtifactPayloadSection
        payload={{
          status: "text",
          artifactId: "artifact-overlay-scrollbar" as ArtifactId,
          encoding: "utf8",
          text,
        }}
      />
    );
    const { container, rerender } = render(payload("first line\n".repeat(200)));
    const preview = container.querySelector<HTMLElement>(".meridian-artifact-payload__preview");
    if (preview === null) {
      throw new Error("the payload section drew no preview");
    }
    await untilInsideAct(() =>
      expect
        .poll(() => preview.hasAttribute(OVERLAY_VIEWPORT_ATTRIBUTE), {
          timeout: OVERLAY_START_TIMEOUT_MS,
        })
        .toBe(true),
    );
    const barCount = preview.querySelectorAll(".os-scrollbar").length;
    expect(barCount).toBeGreaterThan(0);

    rerender(payload("second line\n".repeat(200)));

    expect(preview.textContent).toContain("second line");
    expect(preview.querySelectorAll(".os-scrollbar").length).toBe(barCount);
  });
});
