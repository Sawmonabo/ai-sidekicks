// The overlay scrollbar in Chromium, through each window's own copy of the library.
//
// Each rail destination and settings page, opened in a short window, draws the bar of every
// scroller it overflows over its content, and the conversation draws none: no scroller shows the
// platform's bar. The window is shorter than a desktop window's floor so every screen overflows;
// Remote Control's surfaces run these screens with no window floor at all. The sweep covers what
// each screen draws on opening, and two states opened after it: the composer's command list and a
// run's step panel. The draft box's bar is covered in the text-box tier, Review's diff and the
// command palette's list with their bars showing in the accessibility tier, and all three scrolled
// in the endurance tier. Two scrollers are covered nowhere until a screen mounts them: the
// workflow start candidates, which nothing renders yet, and the Preview tab strip, which only the
// Preview pane's content draws, a body the Preview pane does not mount yet. A plain scroller
// planted beside them, and an overlay forced onto the conversation, are the negative controls the
// sweep must report.
//
// A row's scroller, a payload and a pane's body wait for a first pointer move, wheel, scroll or
// focus past the deadline an idle start keeps, and the transcript's pane body attaches no bar at
// all; a bar that starts when its window is idle starts by its deadline in a window that never
// idles, which an idle callback with no deadline, never run, shows. A payload whose text changes
// keeps its bar, which React's `textContent` write would delete from a box holding bare text. A
// window whose library copy fails to load gives its scrollers the platform's bar back and records
// the failure once.
//
// A bar sits inside its scroller, so it scrolls with the content unless it is moved back by the
// scroll offset; it stays at the scroller's edges through a scroll, and through a resize that
// changes the scroll range partway down.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import {
  SESSION_ID,
  TRANSCRIPT_STATES_SCENARIO_ID,
} from "#fixtures/scenarios/transcript-states.js";
import { WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { CONCURRENT_STREAMING_SCENARIO_ID } from "#fixtures/scenarios/concurrent-streaming.js";
import { SCENARIO_FIXTURE_GLOBAL } from "#renderer/app/fixture/global-names.js";
import { ScenarioFixtureControl } from "#renderer/services/daemon/selection.fixture.js";
import { WINDOW_HEIGHT_FLOOR_REM } from "#renderer/styles/palette.js";
import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { ArtifactPayloadSection } from "#renderer/features/inspector/artifacts/components/ArtifactPayloadSection.js";
import { PayloadRowWindow } from "#renderer/features/workflows/runs/page/step/components/StepPayload/PayloadRowWindow.js";
import type { ArtifactPayloadReading } from "#renderer/store/artifact-payload.js";
import { routeForDestination } from "#renderer/layout/NavigationRail/destinations.js";
import { useDrawOverlayScrollbar } from "#renderer/hooks/useDrawOverlayScrollbar.js";
import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/capture.js";
import {
  installOverlayScrollbarLibrary,
  waitForOverlayScrollbarLibrary,
} from "#renderer/lib/overlay-scrollbar-library.js";
import { RAIL_DESTINATIONS } from "#renderer/routing/readers.js";
import { SETTINGS_PAGE_IDS } from "#renderer/routing/settings-page-ids.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { nextFrame } from "../helpers/animation-frame.js";
import { liveBridgeWrapper } from "../helpers/app/frame-fixtures.js";
import { renderAppSettled } from "../helpers/app/harness.js";
import { changeLayout } from "../helpers/animation-frame.js";
import { advanceScenarioUntil } from "../helpers/scenario/manual-clock.js";
import { untilInsideAct } from "../helpers/settle.js";

/**
 * A window short enough that every screen holds more than it shows: shorter than a desktop
 * window's floor, as a Remote Control surface may be.
 */
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

/**
 * The scrollers whose bar waits for a first interaction: an artifact's payload, a step's payload
 * rows and a pane's body.
 */
const WAITING_SCROLLERS = [
  ".meridian-artifact-payload__preview",
  ".meridian-workflow-payload__window",
  ".meridian-pane--inspector > .meridian-pane__body",
] as const;

/** How long each task holds a busy window's main thread, in milliseconds. */
const BUSY_TASK_MS = 20;

/** Past the idle start's deadline, with room for a busy window's task in front of it. */
const BUSY_WINDOW_START_TIMEOUT_MS = 3000;

/** How long a bar may take to start: the library's load plus its window's idle time. */
const OVERLAY_START_TIMEOUT_MS = 5000;

/**
 * How long a key's smooth scroll may take to move a scroller before the wait gives up: a ceiling,
 * not a wait, since a loaded host draws the scroll's first frame late.
 */
const KEYBOARD_SCROLL_TIMEOUT_MS = 5000;

/** How long a first PageDown may leave a scroller still before the key is pressed again. */
const KEYBOARD_SCROLL_RETRY_MS = 1000;
/** Subpixel slack for a bar's edge against its scroller's. */
const EDGE_TOLERANCE_PX = 0.5;

const SESSION_ROUTE = formatRoute({ kind: "session", sessionId: SESSION_ID });

/** A state a screen opens into once it has drawn, with a scroller only that state shows. */
interface OpenedState {
  readonly name: string;
  readonly route: string;
  /** The scenario the app plays, one that answers the reads the state's screen makes. */
  readonly scenarioId: string;
  /** The window's size, in CSS pixels. */
  readonly window: { readonly width: number; readonly height: number };
  readonly scrollerSelector: string;
  /** Opens the state in the app's window. */
  readonly open: (appWindow: Window) => Promise<void>;
}

const OPENED_STATES: readonly OpenedState[] = [
  {
    name: "the composer's command list",
    route: SESSION_ROUTE,
    scenarioId: TRANSCRIPT_STATES_SCENARIO_ID,
    // At the height floor: the composer with its list open stands taller than the short window,
    // which would leave the pane row no height at all.
    window: {
      width: SHORT_WINDOW.width,
      height: WINDOW_HEIGHT_FLOOR_REM * DEFAULT_APPEARANCE_RECORD.textSize,
    },
    scrollerSelector: ".meridian-command-discovery__scroller",
    open: async (appWindow) => {
      const line = await untilDrawn(appWindow, ".meridian-composer textarea");
      line.focus();
      await act(async () => {
        await userEvent.keyboard("/");
      });
    },
  },
  {
    name: "a run's step panel",
    // The failed build's step carries the last lines its process printed, taller than the run
    // graph beside the panel, whose height the panel takes.
    route: formatRoute({ kind: "workflows", tab: "runs", runId: WORKFLOW_RUN_IDS.processExited }),
    scenarioId: CONCURRENT_STREAMING_SCENARIO_ID,
    window: SHORT_WINDOW,
    scrollerSelector: ".meridian-workflow-step__scroller",
    // The run page opens its step panel on the failed step, once the run is read on the
    // scenario's clock.
    open: async (appWindow) => {
      await advanceScenarioUntil(runningScenario(), () => {
        expect(
          appWindow.document.querySelector(".meridian-workflow-step__scroller"),
        ).not.toBeNull();
      });
    },
  },
];

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

beforeEach(async () => {
  document.location.hash = "";
  await page.viewport(SHORT_WINDOW.width, SHORT_WINDOW.height);
});

afterEach(async () => {
  cleanup();
  await page.viewport(tierViewport.width, tierViewport.height);
});

describe("the overlay scrollbar", () => {
  // Every rail destination and every settings page as each opens, so a new one is swept the day
  // it is declared.
  const routes = [
    ...RAIL_DESTINATIONS.map((destination) =>
      formatRoute(routeForDestination(destination, undefined)),
    ),
    ...SETTINGS_PAGE_IDS.map((page) => formatRoute({ kind: "settings", page })),
  ];
  for (const route of routes) {
    it(`draws the bar of every scroller ${route} overflows on opening over its content`, async () => {
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

  for (const state of OPENED_STATES) {
    it(`draws the bar of ${state.name} over its content`, async () => {
      document.location.hash = state.route;
      await page.viewport(state.window.width, state.window.height);
      const appWindow = await renderAppSettled(state.scenarioId);
      await state.open(appWindow);

      // The state's own scroller overflows, so the sweep below covers it.
      await untilInsideAct(() =>
        expect
          .poll(
            () =>
              scrollingElements(appWindow.document).some((element) =>
                element.matches(state.scrollerSelector),
              ),
            { timeout: OVERLAY_START_TIMEOUT_MS },
          )
          .toBe(true),
      );
      await untilInsideAct(() =>
        expect
          .poll(() => scrollersDrawnWrongOnceReached(appWindow.document), {
            timeout: OVERLAY_START_TIMEOUT_MS,
          })
          .toStrictEqual([]),
      );
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
    expect(appWindow.document.activeElement, "the conversation took no focus").toBe(conversation);
    // Chromium drops about one first key scroll in a hundred in a newly made window, though the
    // key reaches the focused conversation uncanceled; a second press has scrolled it every time.
    await untilInsideAct(async () => {
      await userEvent.keyboard("{PageDown}");
      if (!(await isScrolledWithin(conversation, KEYBOARD_SCROLL_RETRY_MS))) {
        await userEvent.keyboard("{PageDown}");
      }
      await expect
        .poll(() => conversation.scrollTop, { timeout: KEYBOARD_SCROLL_TIMEOUT_MS })
        .toBeGreaterThan(0);
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

  it("starts no payload's or pane body's bar until a person reaches for it", async () => {
    installMeridianTokens(document);
    installOverlayScrollbarLibrary(document);
    const BridgeHost = liveBridgeWrapper();
    const { container } = render(
      <BridgeHost>
        <div style={{ inlineSize: "30rem" }}>
          <ArtifactPayloadSection payload={textPayload("a payload line\n".repeat(200))} />
          <PayloadRowWindow
            rowCount={200}
            label="Output of a step"
            className=""
            renderRow={(rowIndex) => <span>row {rowIndex}</span>}
          />
          <div style={{ display: "flex", blockSize: "12rem" }}>
            <PaneFrame kind="inspector" sessionId="session-overlay-scrollbar">
              <div style={{ blockSize: "40rem" }}>an inspector body taller than its pane</div>
            </PaneFrame>
            <PaneFrame kind="transcript" sessionId="session-overlay-scrollbar">
              <div style={{ blockSize: "40rem" }}>a conversation taller than its pane</div>
            </PaneFrame>
          </div>
        </div>
      </BridgeHost>,
    );
    const waiting = WAITING_SCROLLERS.map((selector) => requireElement(container, selector));
    const transcriptBody = requireElement(
      container,
      ".meridian-pane--transcript > .meridian-pane__body",
    );

    // Past the deadline an idle start keeps, each still waits, with the platform's bar hidden.
    await waitForOverlayScrollbarLibrary(document);
    await new Promise((resolve) => setTimeout(resolve, IDLE_START_DEADLINE_PASSED_MS));
    expect(waiting.map(describeStart)).toStrictEqual(WAITING_SCROLLERS.map(() => "waiting"));
    // The conversation draws no bar, so the transcript's pane body attaches none at all.
    expect(describeStart(transcriptBody)).toBe("none");

    // A pointer move over each starts its bar inside that event.
    for (const scroller of [...waiting, transcriptBody]) {
      scroller.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    }
    expect(waiting.map(describeStart)).toStrictEqual(WAITING_SCROLLERS.map(() => "started"));
    expect(describeStart(transcriptBody)).toBe("none");
  });

  it("starts a bar by its deadline in a window that never idles", async () => {
    installMeridianTokens(document);
    installOverlayScrollbarLibrary(document);
    await waitForOverlayScrollbarLibrary(document);
    const busyWindow = keepTheWindowBusy();
    try {
      // Negative control: an idle callback with no deadline, asked for beside the bar's start.
      let idleCallbackRan = false;
      const idleCallback = requestIdleCallback(() => {
        idleCallbackRan = true;
      });
      const { container } = render(<ScrollerUnderTest />);
      const scroller = requireElement(container, ".scroller-under-test");
      await untilInsideAct(() =>
        expect
          .poll(() => describeStart(scroller), { timeout: BUSY_WINDOW_START_TIMEOUT_MS })
          .toBe("started"),
      );
      // The window never idled, so the bar started on its deadline and not on an idle period.
      expect(idleCallbackRan).toBe(false);
      cancelIdleCallback(idleCallback);
    } finally {
      busyWindow.stop();
    }
  });

  it("keeps a payload's bar when its text changes", async () => {
    installMeridianTokens(document);
    installOverlayScrollbarLibrary(document);
    const { container, rerender } = render(
      <ArtifactPayloadSection payload={textPayload("first line\n".repeat(200))} />,
    );
    const preview = requireElement(container, ".meridian-artifact-payload__preview");
    await waitForOverlayScrollbarLibrary(document);
    preview.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    expect(preview.hasAttribute(OVERLAY_VIEWPORT_ATTRIBUTE)).toBe(true);
    const barCount = preview.querySelectorAll(".os-scrollbar").length;
    expect(barCount).toBeGreaterThan(0);

    rerender(<ArtifactPayloadSection payload={textPayload("second line\n".repeat(200))} />);

    expect(preview.textContent).toContain("second line");
    expect(preview.querySelectorAll(".os-scrollbar").length).toBe(barCount);
  });

  it("holds a bar at its scroller's edges through a scroll, and through a resize partway down", async () => {
    installMeridianTokens(document);
    installOverlayScrollbarLibrary(document);
    await waitForOverlayScrollbarLibrary(document);
    const { container } = render(<ScrollerUnderTest />);
    const scroller = requireElement(container, ".scroller-under-test");
    await untilInsideAct(() =>
      expect
        .poll(() => describeStart(scroller), { timeout: OVERLAY_START_TIMEOUT_MS })
        .toBe("started"),
    );
    const bar = requireElement(scroller, ".os-scrollbar-vertical");
    const resting = barInsetFrom(scroller, bar);

    await changeLayout(() => {
      scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
    });
    expect(barInsetFrom(scroller, bar), "halfway down").toStrictEqual(resting);

    // Taller, so the same offset sits at a larger share of a shorter range.
    await changeLayout(() => {
      scroller.style.blockSize = "8rem";
    });
    expect(barInsetFrom(scroller, bar), "once resized").toStrictEqual(resting);
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

/** Whether `scroller`'s bar has started, waits to start, or was never attached. */
function describeStart(scroller: Element): "started" | "waiting" | "none" {
  if (scroller.hasAttribute(OVERLAY_VIEWPORT_ATTRIBUTE)) {
    return "started";
  }
  return scroller.hasAttribute(AWAITING_OVERLAY_ATTRIBUTE) ? "waiting" : "none";
}

/** How far a bar's edges sit inside its scroller's, rounded to the edge tolerance. */
function barInsetFrom(
  scroller: HTMLElement,
  bar: HTMLElement,
): { readonly top: number; readonly bottom: number } {
  const box = scroller.getBoundingClientRect();
  const drawn = bar.getBoundingClientRect();
  const round = (value: number): number =>
    Math.round(value / EDGE_TOLERANCE_PX) * EDGE_TOLERANCE_PX;
  return { top: round(drawn.top - box.top), bottom: round(box.bottom - drawn.bottom) };
}

/** The scenario the app's fixture composition plays, as it hangs it on the page. */
function runningScenario(): ScenarioFixtureControl {
  const control: unknown = Reflect.get(globalThis, SCENARIO_FIXTURE_GLOBAL);
  if (!(control instanceof ScenarioFixtureControl)) {
    throw new Error("the app's fixture composition hung no scenario on the page");
  }
  return control;
}

/** The element `selector` names in the app's window, once the window has drawn it. */
async function untilDrawn(appWindow: Window, selector: string): Promise<HTMLElement> {
  await untilInsideAct(() =>
    expect
      .poll(() => appWindow.document.querySelector(selector), {
        timeout: OVERLAY_START_TIMEOUT_MS,
      })
      .not.toBeNull(),
  );
  return requireElement(appWindow.document, selector);
}

/**
 * Whether `scroller` has left its top within `timeoutMs`, read every animation frame and once more
 * at the deadline, so a window that stops drawing cannot hold the wait past it.
 */
async function isScrolledWithin(scroller: HTMLElement, timeoutMs: number): Promise<boolean> {
  const ownerWindow = viewOf(scroller.ownerDocument);
  const deadline = ownerWindow.performance.now() + timeoutMs;
  while (scroller.scrollTop === 0) {
    const remainingMs = deadline - ownerWindow.performance.now();
    if (remainingMs <= 0) {
      break;
    }
    await Promise.race([
      nextFrame(ownerWindow),
      new Promise((resolve) => ownerWindow.setTimeout(resolve, remainingMs)),
    ]);
  }
  return scroller.scrollTop > 0;
}

function requireElement(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`nothing drew ${selector}`);
  }
  return element;
}

/** A payload of text, as an artifact's payload section reads it. */
function textPayload(text: string): ArtifactPayloadReading {
  return {
    status: "text",
    artifactId: "artifact-overlay-scrollbar" as ArtifactId,
    encoding: "utf8",
    text,
  };
}

/**
 * Keeps a task queued on the window at every moment, each holding the main thread for a while, so
 * no idle period ever comes, until `stop` is called.
 */
function keepTheWindowBusy(): { readonly stop: () => void } {
  const channel = new MessageChannel();
  let isBusy = true;
  channel.port1.onmessage = () => {
    const holdUntil = performance.now() + BUSY_TASK_MS;
    while (performance.now() < holdUntil) {
      /* hold the main thread, as a window streaming without a pause does */
    }
    if (isBusy) {
      channel.port2.postMessage(undefined);
    }
  };
  channel.port2.postMessage(undefined);
  return {
    stop: () => {
      isBusy = false;
      channel.port1.close();
    },
  };
}

/** A plain scroller drawing its bar through the hook. */
function ScrollerUnderTest(): React.JSX.Element {
  const scrollbarRef = useDrawOverlayScrollbar<HTMLDivElement>();
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
