// Every scroller on screen but the conversation draws its bar over its content, through its own
// window's copy of the overlay scrollbar library, and the conversation draws none: no scroller
// shows the platform's bar. Measured in Chromium on the real app in a short window, where the
// screens overflow, after a pointer move over each scroller, which starts a bar that waits for
// one; a plain scroller planted beside them, and an overlay forced onto the conversation, are the
// negative controls the sweep must report. A payload whose text changes keeps its bar, which
// React's `textContent` write would delete from a box holding bare text. A window whose library
// copy fails to load gives its scrollers the platform's bar back and records the failure once.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import {
  SESSION_ID,
  TRANSCRIPT_STATES_SCENARIO_ID,
} from "#fixtures/scenarios/transcript-states.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { ArtifactPayloadSection } from "#renderer/features/repos/artifacts/components/ArtifactPayloadSection.js";
import { routeForDestination } from "#renderer/layout/NavigationRail/destinations.js";
import { useOverlayScrollbar } from "#renderer/hooks/useOverlayScrollbar.js";
import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/capture.js";
import {
  installOverlayScrollbarLibrary,
  waitForOverlayScrollbarLibrary,
} from "#renderer/lib/overlay-scrollbar-library.js";
import { RAIL_DESTINATIONS } from "#renderer/routing/readers.js";
import { SETTINGS_PAGE_IDS } from "#renderer/routing/settings-page-ids.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { renderAppSettled } from "../helpers/app/harness.js";

/** A window short enough that every screen holds more than it shows. */
const SHORT_WINDOW = { width: 1024, height: 360 };

/** The conversation's scroller, the one that draws no bar at all. */
const CONVERSATION_SCROLLER = ".meridian-transcript-viewport__scroll-container";

/** The terminal's own emulator, which draws its own bar inside the terminal. */
const TERMINAL_EMULATOR = ".xterm";

/** The marker the library puts on the element it scrolls. */
const OVERLAY_VIEWPORT_ATTRIBUTE = "data-overlayscrollbars-viewport";

/** Longer than an idle start's deadline, so a bar started when idle has started by then. */
const IDLE_START_DEADLINE_PASSED_MS = 1000;

/**
 * A bar the library draws: it marks a bar with something to scroll this way, and a bar without
 * it stays transparent whatever its fade.
 */
const DRAWN_BAR = ".os-scrollbar-visible";

/** The library's marker for an element whose bar has not started. */
const AWAITING_OVERLAY_ATTRIBUTE = "data-overlayscrollbars-initialize";

/** How long a bar may take to start: the library's load plus its window's idle time. */
const OVERLAY_START_TIMEOUT_MS = 5000;

const SESSION_ROUTE = formatRoute({ kind: "session", sessionId: SESSION_ID });

const tierViewport = { width: window.innerWidth, height: window.innerHeight };

/** Every element under `root` that scrolls content it does not show, by its classes. */
function scrollingElements(root: Document): HTMLElement[] {
  const view = viewOf(root);
  return Array.from(root.body.querySelectorAll<HTMLElement>("*")).filter((element) => {
    if (element.closest(TERMINAL_EMULATOR) !== null) {
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
 * One line per scroller drawn wrong: one showing the platform's bar, the conversation carrying an
 * overlay, or any other scroller without one, or with one the library will not draw.
 */
function scrollersDrawnWrong(root: Document): string[] {
  const view = viewOf(root);
  return scrollingElements(root).flatMap((element) => {
    const showsPlatformBar = view.getComputedStyle(element).scrollbarWidth !== "none";
    const hasOverlay = element.hasAttribute(OVERLAY_VIEWPORT_ATTRIBUTE);
    const drawsOverlay = element.querySelector(`:scope > ${DRAWN_BAR}`) !== null;
    const isConversation = element.matches(CONVERSATION_SCROLLER);
    if (!showsPlatformBar && hasOverlay !== isConversation && drawsOverlay !== isConversation) {
      return [];
    }
    return [
      `${describeElement(element)} (platform bar ${String(showsPlatformBar)}, ` +
        `overlay ${String(hasOverlay)}, drawn ${String(drawsOverlay)})`,
    ];
  });
}

/**
 * {@link scrollersDrawnWrong} after a pointer move over every scroller, as a person reaching for
 * a bar makes, which starts a bar that waits for one.
 */
function scrollersDrawnWrongOnceReached(root: Document): string[] {
  for (const element of scrollingElements(root)) {
    element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
  }
  return scrollersDrawnWrong(root);
}

function viewOf(root: Document): Window {
  const view = root.defaultView;
  if (view === null) {
    throw new Error("the window under test has no view");
  }
  return view;
}

function isScrollingOverflow(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll";
}

function describeElement(element: Element): string {
  return `${element.localName}${Array.from(element.classList, (name) => `.${name}`).join("")}`;
}

/** Plants a scroller that draws the platform's bar, which the sweep must report. */
function plantPlainScroller(root: Document): void {
  const plainScroller = root.createElement("div");
  plainScroller.className = "plain-scroller";
  plainScroller.style.cssText = "overflow: auto; block-size: 4rem";
  const tallContent = root.createElement("div");
  tallContent.style.blockSize = "20rem";
  plainScroller.append(tallContent);
  root.body.append(plainScroller);
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
  // Every rail destination and every settings page, so a new one is swept the day it is declared.
  const routes = [
    ...RAIL_DESTINATIONS.map((destination) =>
      formatRoute(routeForDestination(destination, undefined)),
    ),
    ...SETTINGS_PAGE_IDS.map((page) => formatRoute({ kind: "settings", page })),
  ];
  for (const route of routes) {
    it(`draws every scroller's bar over its content at ${route}`, async () => {
      document.location.hash = route;
      const appWindow = await renderAppSettled(TRANSCRIPT_STATES_SCENARIO_ID);
      expect(appWindow.innerHeight).toBe(SHORT_WINDOW.height);

      // Something on the screen scrolls, or the sweep below would pass on nothing.
      expect(scrollingElements(appWindow.document).length).toBeGreaterThan(0);
      await untilInsideAct(() =>
        expect
          .poll(() => scrollersDrawnWrongOnceReached(appWindow.document), {
            timeout: OVERLAY_START_TIMEOUT_MS,
          })
          .toStrictEqual([]),
      );

      // Negative control: a plain scroller in the same window is reported.
      plantPlainScroller(appWindow.document);
      expect(scrollersDrawnWrong(appWindow.document)).toStrictEqual([
        "div.plain-scroller (platform bar true, overlay false, drawn false)",
      ]);
    });
  }

  it("draws no bar on the conversation", async () => {
    document.location.hash = SESSION_ROUTE;
    const appWindow = await renderAppSettled(TRANSCRIPT_STATES_SCENARIO_ID);
    await untilInsideAct(() =>
      expect
        .poll(() => appWindow.document.querySelector(CONVERSATION_SCROLLER), {
          timeout: OVERLAY_START_TIMEOUT_MS,
        })
        .not.toBeNull(),
    );
    const conversation = appWindow.document.querySelector<HTMLElement>(CONVERSATION_SCROLLER);
    if (conversation === null) {
      throw new Error("the session screen drew no conversation");
    }
    // The scenario's log is still loading here, so the log's height is set from outside, as the
    // virtualizer sets it, to make the conversation hold more than it shows.
    const sizer = conversation.querySelector<HTMLElement>(".meridian-transcript-viewport__sizer");
    if (sizer === null) {
      throw new Error("the conversation drew no sizer");
    }
    sizer.style.height = "100rem";
    expect(scrollingElements(appWindow.document)).toContain(conversation);

    // It still scrolls from the keyboard.
    conversation.focus();
    await untilInsideAct(async () => {
      await userEvent.keyboard("{PageDown}");
      await expect.poll(() => conversation.scrollTop).toBeGreaterThan(0);
    });
    await untilInsideAct(() =>
      expect
        .poll(() => scrollersDrawnWrongOnceReached(appWindow.document), {
          timeout: OVERLAY_START_TIMEOUT_MS,
        })
        .toStrictEqual([]),
    );

    // Negative controls: a plain scroller is reported, and so is the conversation once an
    // overlay is forced onto it.
    plantPlainScroller(appWindow.document);
    const library = await waitForOverlayScrollbarLibrary(appWindow.document);
    if (library === undefined) {
      throw new Error("the app window loaded no overlay scrollbar library");
    }
    // Called without options the library only looks an instance up; with them it starts one.
    const forced = library.OverlayScrollbars(
      { target: conversation, elements: { viewport: conversation } },
      {},
    );
    expect(scrollersDrawnWrong(appWindow.document)).toStrictEqual([
      "div.meridian-transcript-viewport__scroll-container.meridian-focus-inset (platform bar false, " +
        "overlay true, drawn true)",
      "div.plain-scroller (platform bar true, overlay false, drawn false)",
    ]);
    forced.destroy();
  });

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
    // A payload row's bar waits for a person to reach for it, past the deadline an idle start
    // keeps, with the platform's bar hidden meanwhile.
    await waitForOverlayScrollbarLibrary(document);
    await new Promise((resolve) => setTimeout(resolve, IDLE_START_DEADLINE_PASSED_MS));
    expect(preview.hasAttribute(OVERLAY_VIEWPORT_ATTRIBUTE)).toBe(false);
    expect(preview.hasAttribute(AWAITING_OVERLAY_ATTRIBUTE)).toBe(true);
    preview.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    expect(preview.hasAttribute(OVERLAY_VIEWPORT_ATTRIBUTE)).toBe(true);
    const barCount = preview.querySelectorAll(".os-scrollbar").length;
    expect(barCount).toBeGreaterThan(0);

    rerender(payload("second line\n".repeat(200)));

    expect(preview.textContent).toContain("second line");
    expect(preview.querySelectorAll(".os-scrollbar").length).toBe(barCount);
  });

  it("gives the platform's bar back and records one failure when the library cannot load", async () => {
    // A window document whose policy refuses every script, so the library's script fails there.
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const frameDocument = frame.contentDocument;
    if (frameDocument === null) {
      throw new Error("the frame has no document");
    }
    const scriptPolicy = frameDocument.createElement("meta");
    scriptPolicy.httpEquiv = "Content-Security-Policy";
    scriptPolicy.content = "script-src 'none'";
    frameDocument.head.append(scriptPolicy);
    installOverlayScrollbarLibrary(frameDocument);
    const forwardedLines: string[] = [];
    const detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      forwardedLines.push(...jsonLines.split("\n").filter((line) => line.length > 0));
    });
    try {
      const mountPoint = frameDocument.createElement("div");
      frameDocument.body.append(mountPoint);
      render(
        <>
          <ScrollerUnderTest />
          <ScrollerUnderTest />
        </>,
        { container: mountPoint },
      );
      const scrollers = Array.from(
        mountPoint.querySelectorAll<HTMLElement>(".scroller-under-test"),
      );
      expect(scrollers).toHaveLength(2);
      await untilInsideAct(() =>
        expect
          .poll(
            () => scrollers.map((scroller) => scroller.hasAttribute(AWAITING_OVERLAY_ATTRIBUTE)),
            {
              timeout: OVERLAY_START_TIMEOUT_MS,
            },
          )
          .toStrictEqual([false, false]),
      );
      expect(
        scrollers.map((scroller) => frame.contentWindow?.getComputedStyle(scroller).scrollbarWidth),
      ).toStrictEqual(["auto", "auto"]);
      windowDiagnosticCapture.flush();
      expect(
        forwardedLines
          .map((line) => JSON.parse(line) as { source: string; kind: string })
          .filter((record) => record.source === "lib/overlay-scrollbar-library"),
      ).toStrictEqual([expect.objectContaining({ kind: "overlay-scrollbar-library-unloaded" })]);
    } finally {
      detachForwarder();
      cleanup();
      frame.remove();
    }
  });
});

/** A plain scroller drawing its bar through the hook, for a window the library cannot reach. */
function ScrollerUnderTest(): React.JSX.Element {
  const scrollbarRef = useOverlayScrollbar<HTMLDivElement>();
  return (
    <div
      className="scroller-under-test"
      ref={scrollbarRef}
      style={{ overflow: "auto", blockSize: "4rem" }}
    >
      <div style={{ blockSize: "20rem" }} />
    </div>
  );
}
