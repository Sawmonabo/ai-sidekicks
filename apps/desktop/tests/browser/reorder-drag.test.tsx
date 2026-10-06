// Reordering by dragging with a real pointer: the item rides the pointer by `transform`, its
// neighbors glide aside, the new order commits once on release, and Escape, a canceled pointer or
// a refused move puts everything back with no new order; a strip held at its edge scrolls. Real
// input goes in through the browser's own input pipeline (CDP `Input.dispatchMouseEvent`),
// because pointer capture holds only for a pointer whose button the browser itself saw pressed.
//
// The pane row is drawn into a second document, as every window a person sees is in the app: a
// listener bound to the test page's own document would hear nothing from it.

import { useState } from "react";
import { createPortal } from "react-dom";
import { cdp, userEvent } from "vitest/browser";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FrameWindows } from "../helpers/frame-windows.js";
import { renderSettled } from "../helpers/app/harness.js";
import { bridgeWrapper, FixtureBridgeProvider } from "../helpers/app/frame-fixtures.js";
import { liveRegionText, politeText } from "../helpers/live-region.js";
import type { PreviewPage } from "@ai-sidekicks/contracts/preview/methods";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { type AnnouncementPoliteness } from "#renderer/components/LiveAnnouncer/live-announcer.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { PageTabStrip } from "#renderer/features/preview/components/PageTab/PageTabStrip.js";
import { previewPage } from "#renderer/features/preview/page-list-reading.test-support.js";
import { type Refusal } from "#renderer/lib/refusal/refusal.js";
import { SessionPaneLayout } from "#renderer/features/sessions/pane-layout/components/SessionPaneLayout.js";
import type { SessionPane } from "#renderer/features/sessions/pane-layout/pane-layout.js";
import {
  PANE_LAYOUT_RESTORED_PANE_CAP,
  PaneLayoutStore,
} from "#renderer/features/sessions/pane-layout/pane-layout-store.js";
import { type PaneContext } from "#renderer/registries/panes/pane-context.js";
import { PaneRegistry } from "#renderer/registries/panes/pane-registry.js";
import { createFixtureBridge } from "#renderer/services/platform/platform-bridge.fixture.js";
import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";

const frames = new FrameWindows();

afterEach(() => {
  frames.removeAll();
});

/** A point in the test page's viewport, in CSS pixels. */
interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Drives the mouse through CDP. CDP speaks in the top page's coordinates and the test runs in an
 * iframe inside it, so the mapping from a document's viewport is measured from two real moves
 * that document sees, rather than assumed.
 */
class RealMouse {
  readonly #origin: ViewportPoint;
  readonly #scale: number;

  private constructor(origin: ViewportPoint, scale: number) {
    this.#origin = origin;
    this.#scale = scale;
  }

  public static async calibrated(viewportDocument: Document): Promise<RealMouse> {
    const seen: ViewportPoint[] = [];
    const record = (event: PointerEvent): void => {
      seen.push({ x: event.clientX, y: event.clientY });
    };
    viewportDocument.addEventListener("pointermove", record);
    try {
      await sendMouse("mouseMoved", { x: 200, y: 200 }, 0);
      await sendMouse("mouseMoved", { x: 400, y: 400 }, 0);
    } finally {
      viewportDocument.removeEventListener("pointermove", record);
    }
    const [first, second] = [seen.at(-2), seen.at(-1)];
    if (first === undefined || second === undefined) {
      throw new Error("The document saw no pointer move from CDP input.");
    }
    const scale = 200 / (second.x - first.x);
    return new RealMouse({ x: 200 - first.x * scale, y: 200 - first.y * scale }, scale);
  }

  public async press(at: ViewportPoint): Promise<void> {
    await sendMouse("mouseMoved", this.#toPage(at), 0);
    await sendMouse("mousePressed", this.#toPage(at), 1);
  }

  /** Moves with the button held, in steps, as a hand does. */
  public async dragTo(from: ViewportPoint, to: ViewportPoint, steps: number): Promise<void> {
    for (let step = 1; step <= steps; step += 1) {
      const point = {
        x: from.x + ((to.x - from.x) * step) / steps,
        y: from.y + ((to.y - from.y) * step) / steps,
      };
      await sendMouse("mouseMoved", this.#toPage(point), 1);
    }
  }

  public async release(at: ViewportPoint): Promise<void> {
    await sendMouse("mouseReleased", this.#toPage(at), 0);
  }

  #toPage(point: ViewportPoint): ViewportPoint {
    return {
      x: this.#origin.x + point.x * this.#scale,
      y: this.#origin.y + point.y * this.#scale,
    };
  }
}

async function sendMouse(
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
  at: ViewportPoint,
  buttons: number,
): Promise<void> {
  await cdp().send("Input.dispatchMouseEvent", {
    type,
    x: at.x,
    y: at.y,
    button: type === "mouseMoved" && buttons === 0 ? "none" : "left",
    buttons,
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
}

/** Lets `ownerWindow` paint once, so what was written is laid out and drawn. */
async function nextFrame(ownerWindow: Window): Promise<void> {
  await new Promise<void>((resolve) => {
    ownerWindow.requestAnimationFrame(() => {
      resolve();
    });
  });
}

/** Waits for every animation on `elements` to end, so positions read as settled. */
async function glidesEnded(elements: readonly Element[]): Promise<void> {
  await Promise.all(
    elements.flatMap((element) => element.getAnimations().map(async (glide) => glide.finished)),
  );
}

/** The horizontal offset an element's own `transform` carries, or `NaN` for any other value. */
function translateXOf(element: HTMLElement): number {
  const match = /^translateX\((-?[\d.]+)px\)$/u.exec(element.style.transform);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

function centerOf(element: Element): ViewportPoint {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function lefts(elements: readonly Element[]): number[] {
  return elements.map((element) => element.getBoundingClientRect().left);
}

/** Four pages, so a drag has neighbors to pass on either side. */
const FOUR_PAGES = ["a", "b", "c", "d"].map((pageId) => previewPage({ pageId }));

/** Eight pages, more than a narrow strip shows, so the strip scrolls. */
const EIGHT_PAGES = ["a", "b", "c", "d", "e", "f", "g", "h"].map((pageId) =>
  previewPage({ pageId }),
);

/** A refusal the strip's move answers with, as the daemon's would be. */
const REFUSED_MOVE: Refusal = { code: "refused", detail: "The move was refused.", origin: "test" };

/**
 * Waits for one lane of the live region to say `sentence`. Inside `act`, since the announcer
 * publishes a queued sentence and clears a held one on its own timer.
 */
async function heard(
  container: HTMLElement,
  sentence: string,
  politeness: AnnouncementPoliteness = "polite",
): Promise<void> {
  await act(async () => {
    await vi.waitFor(() => {
      expect(liveRegionText(container, politeness)).toBe(sentence);
    });
  });
}

/** The strip's window, on real time, so the edge scroll's frames run as a window's would. */
const RealTimeWindow = bridgeWrapper(createFixtureBridge({ scenario: FIRST_RUN_SCENARIO }).bridge);

async function mountTabs(options: {
  readonly onReorder?: (pageId: string, toIndex: number) => void;
  readonly onSelect?: (pageId: string) => void;
  readonly refuses?: boolean;
  readonly pages?: readonly PreviewPage[];
  readonly stripWidth?: string;
}): Promise<{ readonly container: HTMLElement; readonly tabs: () => HTMLElement[] }> {
  installMeridianTokens(document);
  const mount = await renderSettled(
    <RealTimeWindow>
      <LiveAnnouncerProvider>
        <div style={{ inlineSize: options.stripWidth ?? "auto" }}>
          <ReorderingTabStrip
            pages={options.pages ?? FOUR_PAGES}
            refuses={options.refuses ?? false}
            onReorder={options.onReorder ?? vi.fn()}
            onSelect={options.onSelect ?? vi.fn()}
          />
        </div>
      </LiveAnnouncerProvider>
    </RealTimeWindow>,
  );
  // Measured against the tabs' own font, not the fallback drawn before it loads.
  await document.fonts.ready;
  return {
    container: mount.container,
    tabs: () => [...mount.container.querySelectorAll<HTMLElement>(".meridian-preview-tab")],
  };
}

/** The animations a script runs on `elements` that are still moving them; CSS transitions aside. */
function runningScriptAnimations(elements: readonly Element[]): Animation[] {
  return elements.flatMap((element) =>
    element
      .getAnimations()
      .filter(
        (animation) => !(animation instanceof CSSTransition) && animation.playState === "running",
      ),
  );
}

function tabAt(tabs: readonly HTMLElement[], index: number): HTMLElement {
  const tab = tabs[index];
  if (tab === undefined) {
    throw new Error(`the strip drew no tab at ${String(index)}`);
  }
  return tab;
}

describe("browser — dragging a tab to reorder", () => {
  afterEach(async () => {
    await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  });

  it("carries a tab on the pointer, parts its neighbors, commits once, and Escape commits nothing", async () => {
    const onReorder = vi.fn();
    const strip = await mountTabs({ onReorder });
    const tabs = strip.tabs();
    const [first, second, third, fourth] = [
      tabAt(tabs, 0),
      tabAt(tabs, 1),
      tabAt(tabs, 2),
      tabAt(tabs, 3),
    ] as const;
    const homeLefts = lefts(tabs);
    const step = (homeLefts[1] ?? 0) - (homeLefts[0] ?? 0);
    const mouse = await RealMouse.calibrated(document);

    // Lift the first tab and carry it past the third.
    const press = centerOf(first);
    const carried = { x: centerOf(third).x + 4, y: press.y };
    await mouse.press(press);
    await mouse.dragTo(press, carried, 12);
    await nextFrame(window);
    const travel = carried.x - press.x;
    expect(translateXOf(first)).toBeCloseTo(travel, 2);
    expect(first.getBoundingClientRect().left).toBeCloseTo((homeLefts[0] ?? 0) + travel, 1);
    // The two tabs it passed glide back one step into the room it left; the last stays put.
    await glidesEnded([second, third]);
    expect(second.getBoundingClientRect().left).toBeCloseTo((homeLefts[1] ?? 0) - step, 1);
    expect(third.getBoundingClientRect().left).toBeCloseTo((homeLefts[2] ?? 0) - step, 1);
    expect(fourth.getBoundingClientRect().left).toBeCloseTo(homeLefts[3] ?? 0, 1);
    expect(onReorder).not.toHaveBeenCalled();

    await act(async () => {
      await mouse.release(carried);
      await nextFrame(window);
    });
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith("a", 2);

    // The new order arrived; every tab glides into its place and wears nothing afterwards.
    const settledTabs = strip.tabs();
    await glidesEnded(settledTabs);
    expect(settledTabs.map((tab) => tab.textContent)).toStrictEqual([
      "Title b",
      "Title c",
      "Title a",
      "Title d",
    ]);
    expect(settledTabs.map((tab) => tab.style.transform)).toStrictEqual(["", "", "", ""]);
    const settledLefts = lefts(settledTabs);
    expect(settledLefts).toStrictEqual(settledLefts.toSorted((left, right) => left - right));
    // The live region names where the dropped tab landed, then lets the sentence go.
    await heard(strip.container, "Moved Title a to position 3 of 4.");
    await heard(strip.container, "");

    // Lift again and press Escape mid-drag: no commit, no sentence, and the tab glides home.
    const pressAgain = centerOf(tabAt(settledTabs, 0));
    const away = { x: pressAgain.x + 120, y: pressAgain.y };
    await mouse.press(pressAgain);
    await mouse.dragTo(pressAgain, away, 8);
    await userEvent.keyboard("{Escape}");
    await mouse.release(away);
    await nextFrame(window);
    await glidesEnded(settledTabs);
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(settledTabs.map((tab) => tab.style.transform)).toStrictEqual(["", "", "", ""]);
    expect(lefts(settledTabs)).toStrictEqual(settledLefts);
    expect(politeText(strip.container)).toBe("");
    expect(liveRegionText(strip.container, "assertive")).toBe("");
  });

  it("commits nothing for a drop on the tab's own place, and a canceled pointer puts it back", async () => {
    const onReorder = vi.fn();
    const strip = await mountTabs({ onReorder });
    const tabs = strip.tabs();
    const first = tabAt(tabs, 0);
    const homeLefts = lefts(tabs);
    const mouse = await RealMouse.calibrated(document);

    // Out past a neighbor and back: released where it started.
    const press = centerOf(first);
    const out = { x: centerOf(tabAt(tabs, 1)).x + 4, y: press.y };
    await mouse.press(press);
    await mouse.dragTo(press, out, 6);
    await mouse.dragTo(out, press, 6);
    await act(async () => {
      await mouse.release(press);
      await nextFrame(window);
    });
    await glidesEnded(tabs);
    expect(onReorder).not.toHaveBeenCalled();
    expect(tabs.map((tab) => tab.style.transform)).toStrictEqual(["", "", "", ""]);
    expect(lefts(tabs)).toStrictEqual(homeLefts);

    // The platform takes the pointer away mid-drag: nothing commits and every tab glides home.
    let pointerId = Number.NaN;
    const notePointer = (event: PointerEvent): void => {
      pointerId = event.pointerId;
    };
    document.addEventListener("pointerdown", notePointer);
    await mouse.press(press);
    document.removeEventListener("pointerdown", notePointer);
    await mouse.dragTo(press, out, 6);
    await act(async () => {
      document.dispatchEvent(new PointerEvent("pointercancel", { pointerId, bubbles: true }));
      await nextFrame(window);
    });
    await mouse.release(out);
    await glidesEnded(tabs);
    expect(onReorder).not.toHaveBeenCalled();
    expect(tabs.map((tab) => tab.style.transform)).toStrictEqual(["", "", "", ""]);
    expect(lefts(tabs)).toStrictEqual(homeLefts);
  });

  it("puts the tabs back when the move is refused", async () => {
    const onReorder = vi.fn();
    const strip = await mountTabs({ onReorder, refuses: true });
    const tabs = strip.tabs();
    const homeLefts = lefts(tabs);
    const mouse = await RealMouse.calibrated(document);

    const press = centerOf(tabAt(tabs, 0));
    const carried = { x: centerOf(tabAt(tabs, 2)).x + 4, y: press.y };
    await mouse.press(press);
    await mouse.dragTo(press, carried, 12);
    await act(async () => {
      await mouse.release(carried);
      await nextFrame(window);
    });
    expect(onReorder).toHaveBeenCalledWith("a", 2);
    await vi.waitFor(async () => {
      await glidesEnded(tabs);
      expect(lefts(tabs)).toStrictEqual(homeLefts);
    });
    expect(tabs.map((tab) => tab.textContent)).toStrictEqual([
      "Title a",
      "Title b",
      "Title c",
      "Title d",
    ]);
    // The refusal's own sentence is read, and no move is named.
    await heard(strip.container, REFUSED_MOVE.detail, "assertive");
    expect(politeText(strip.container)).toBe("");
  });

  it("scrolls a strip held at its edge and drops the tab past what was in view", async () => {
    const onReorder = vi.fn();
    const strip = await mountTabs({ onReorder, pages: EIGHT_PAGES, stripWidth: "20rem" });
    const scroller = strip.container.querySelector<HTMLElement>(".meridian-preview-tabs");
    if (scroller === null) {
      throw new Error("the strip drew no scroller");
    }
    const maximumOffset = scroller.scrollWidth - scroller.clientWidth;
    expect(maximumOffset, "eight tabs overflow the narrow strip").toBeGreaterThan(0);
    const mouse = await RealMouse.calibrated(document);

    // Carry the first tab to the strip's right end and hold it there.
    const press = centerOf(tabAt(strip.tabs(), 0));
    const edge = { x: scroller.getBoundingClientRect().right - 2, y: press.y };
    await mouse.press(press);
    await mouse.dragTo(press, edge, 12);
    // About a second at four steps a second; the wait allows three.
    await vi.waitFor(
      () => {
        expect(scroller.scrollLeft).toBeCloseTo(maximumOffset, 0);
      },
      { timeout: 3000 },
    );

    await act(async () => {
      await mouse.release(edge);
      await nextFrame(window);
    });
    expect(onReorder).toHaveBeenCalledWith("a", EIGHT_PAGES.length - 1);
  });

  it("moves without gliding where reduced motion is asked for, and a short press still selects", async () => {
    await cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const onReorder = vi.fn();
    const onSelect = vi.fn();
    const strip = await mountTabs({ onReorder, onSelect });
    const mouse = await RealMouse.calibrated(document);

    // Under the drag threshold: a click on the tab, not a drag.
    const tabFace = tabAt(strip.tabs(), 1).querySelector(".meridian-preview-tab__face");
    if (tabFace === null) {
      throw new Error("the tab drew no face");
    }
    const tap = centerOf(tabFace);
    await mouse.press(tap);
    await mouse.dragTo(tap, { x: tap.x + 2, y: tap.y }, 2);
    await mouse.release({ x: tap.x + 2, y: tap.y });
    await vi.waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("b");
    });
    expect(onReorder).not.toHaveBeenCalled();

    const tabs = strip.tabs();
    const homeLefts = lefts(tabs);
    const press = centerOf(tabAt(tabs, 0));
    const carried = { x: centerOf(tabAt(tabs, 2)).x + 4, y: press.y };
    await mouse.press(press);
    await mouse.dragTo(press, carried, 12);
    await nextFrame(window);
    // The neighbors are in their new places at once, with nothing gliding them there.
    const step = (homeLefts[1] ?? 0) - (homeLefts[0] ?? 0);
    expect(tabAt(tabs, 1).getBoundingClientRect().left).toBeCloseTo(homeLefts[0] ?? 0, 1);
    expect(tabAt(tabs, 2).getBoundingClientRect().left).toBeCloseTo((homeLefts[2] ?? 0) - step, 1);
    expect(runningScriptAnimations(tabs)).toStrictEqual([]);
    await act(async () => {
      await mouse.release(carried);
      await nextFrame(window);
    });
    expect(onReorder).toHaveBeenCalledWith("a", 2);
    const settledTabs = strip.tabs();
    expect(runningScriptAnimations(settledTabs)).toStrictEqual([]);
    expect(settledTabs.map((tab) => tab.style.transform)).toStrictEqual(["", "", "", ""]);
    const settledLefts = lefts(settledTabs);
    expect(settledLefts).toStrictEqual(settledLefts.toSorted((left, right) => left - right));
  });
});

describe("browser — moving a tab from its menu", () => {
  /** The tab whose page is `pageId`, by its label. */
  function tabOf(tabs: readonly HTMLElement[], pageId: string): HTMLElement {
    const tab = tabs.find((candidate) => candidate.textContent.includes(`Title ${pageId}`));
    if (tab === undefined) {
      throw new Error(`the strip drew no tab for page ${pageId}`);
    }
    return tab;
  }

  /** The open menu's row reading `label`. */
  function menuRow(label: string): HTMLElement {
    const row = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(
      (candidate) => candidate.textContent === label,
    );
    if (row === undefined) {
      throw new Error(`no open menu holds a "${label}" row`);
    }
    return row;
  }

  function pageOrder(tabs: readonly HTMLElement[]): string[] {
    return tabs.map((tab) => tab.textContent.replace(/^.*Title (\w).*$/su, "$1"));
  }

  async function chooseRow(label: string): Promise<void> {
    await act(async () => {
      await userEvent.click(menuRow(label));
    });
  }

  it("opens on Shift+F10 and a right-click, moves the tab to each place and says where", async () => {
    const onReorder = vi.fn();
    const { container, tabs } = await mountTabs({ onReorder });

    // Shift+F10 on a focused tab opens its menu; the strip mints no chord of its own.
    const face = tabOf(tabs(), "b").querySelector("button");
    face?.focus();
    await act(async () => {
      await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await chooseRow("Move right");
    expect(onReorder).toHaveBeenLastCalledWith("b", 2);
    await vi.waitFor(() => {
      expect(pageOrder(tabs())).toStrictEqual(["a", "c", "b", "d"]);
    });
    await heard(container, "Moved Title b to position 3 of 4.");

    const openMenuOn = async (pageId: string): Promise<void> => {
      await act(async () => {
        await userEvent.click(tabOf(tabs(), pageId), { button: "right" });
      });
    };
    await openMenuOn("b");
    await chooseRow("Move to start");
    await vi.waitFor(() => {
      expect(pageOrder(tabs())).toStrictEqual(["b", "a", "c", "d"]);
    });
    await heard(container, "Moved Title b to position 1 of 4.");

    // The first tab has nowhere to go left: both rows are disabled and pressing one moves nothing.
    await openMenuOn("b");
    expect(menuRow("Move left").getAttribute("aria-disabled")).toBe("true");
    expect(menuRow("Move to start").getAttribute("aria-disabled")).toBe("true");
    const callsBefore = onReorder.mock.calls.length;
    await act(async () => {
      menuRow("Move left").click();
    });
    expect(onReorder).toHaveBeenCalledTimes(callsBefore);
    expect(pageOrder(tabs())).toStrictEqual(["b", "a", "c", "d"]);
    await chooseRow("Move to end");
    await vi.waitFor(() => {
      expect(pageOrder(tabs())).toStrictEqual(["a", "c", "d", "b"]);
    });
    await heard(container, "Moved Title b to position 4 of 4.");

    await openMenuOn("b");
    expect(menuRow("Move right").getAttribute("aria-disabled")).toBe("true");
    expect(menuRow("Move to end").getAttribute("aria-disabled")).toBe("true");
    await chooseRow("Move left");
    await vi.waitFor(() => {
      expect(pageOrder(tabs())).toStrictEqual(["a", "c", "b", "d"]);
    });
    await heard(container, "Moved Title b to position 3 of 4.");
    expect(onReorder.mock.calls).toStrictEqual([
      ["b", 2],
      ["b", 0],
      ["b", 3],
      ["b", 2],
    ]);
  });
});

describe("browser — dragging a pane to reorder", () => {
  it("moves a pane by its header in a second document and says where it landed", async () => {
    installMeridianTokens(document);
    const secondWindow = frames.open("second-window");
    if (secondWindow === null) {
      throw new Error("the second window did not open");
    }
    const layout = new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
    const firstPane = layout.open({ kind: "transcript" });
    const secondPane = layout.open({ kind: "terminal" });
    const mount = await renderSettled(
      <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: FIRST_RUN_SCENARIO })}>
        <LiveAnnouncerProvider>
          {createPortal(
            <SessionPaneLayout
              layout={layout}
              registry={registryWithFrames()}
              paneContextFor={paneContextFor}
            />,
            secondWindow.document.body,
          )}
        </LiveAnnouncerProvider>
      </FixtureBridgeProvider>,
    );
    const panels = [...secondWindow.document.querySelectorAll<HTMLElement>("[data-panel]")];
    const [firstPanel, secondPanel] = panels;
    const firstHead = firstPanel?.querySelector(".meridian-pane__head");
    if (firstPanel === undefined || secondPanel === undefined || !firstHead) {
      throw new Error("the second window drew no pane headers");
    }
    const mouse = await RealMouse.calibrated(secondWindow.document);

    const press = centerOf(firstHead);
    const carried = { x: centerOf(secondPanel).x + 8, y: press.y };
    const homeLeft = firstPanel.getBoundingClientRect().left;
    // The lift and the settle re-render the layout, so each gesture runs inside `act`.
    await act(async () => {
      await mouse.press(press);
      await mouse.dragTo(press, carried, 12);
      await nextFrame(secondWindow);
    });
    const travel = carried.x - press.x;
    expect(translateXOf(firstPanel)).toBeCloseTo(travel, 2);
    expect(firstPanel.getBoundingClientRect().left).toBeCloseTo(homeLeft + travel, 1);
    expect(layout.snapshot().panes.map((pane) => pane.paneId)).toStrictEqual([
      firstPane,
      secondPane,
    ]);

    await act(async () => {
      await mouse.release(carried);
      await nextFrame(secondWindow);
    });
    expect(layout.snapshot().panes.map((pane) => pane.paneId)).toStrictEqual([
      secondPane,
      firstPane,
    ]);
    await vi.waitFor(() => {
      expect(politeText(mount.container)).toBe("Moved the Transcript pane to position 2 of 2.");
    });
    const settledPanels = [...secondWindow.document.querySelectorAll<HTMLElement>("[data-panel]")];
    await act(async () => {
      await glidesEnded(settledPanels);
    });
    expect(settledPanels.map((panel) => panel.id)).toStrictEqual([secondPane, firstPane]);
    expect(settledPanels.map((panel) => panel.style.transform)).toStrictEqual(["", ""]);
  });
});

/** The tab strip over a page list it reorders itself, as the Preview act's reading would. */
function ReorderingTabStrip(props: {
  readonly pages: readonly PreviewPage[];
  /** Whether every move is refused, leaving the order as it was. */
  readonly refuses: boolean;
  readonly onReorder: (pageId: string, toIndex: number) => void;
  readonly onSelect: (pageId: string) => void;
}): React.JSX.Element {
  const [pages, setPages] = useState(() => [...props.pages]);
  return (
    <PageTabStrip
      reading={{ kind: "served", frame: { pages, activeIndex: 0 } }}
      onSelect={props.onSelect}
      onClose={vi.fn()}
      onReorder={async (pageId, toIndex) => {
        props.onReorder(pageId, toIndex);
        if (props.refuses) {
          return REFUSED_MOVE;
        }
        setPages((current) => {
          const moved = current.filter((page) => page.pageId !== pageId);
          const page = current.find((candidate) => candidate.pageId === pageId);
          return page === undefined ? current : moved.toSpliced(toIndex, 0, page);
        });
        return undefined;
      }}
    />
  );
}

/** Bodies that wear the real pane chrome, whose header is the grip a pane is dragged by. */
function registryWithFrames(): PaneRegistry {
  const registry = new PaneRegistry();
  for (const kind of ["transcript", "terminal"] as const) {
    registry.register({
      kind,
      owner: "reorder-drag-test",
      render: (context) => (
        <PaneFrame kind={kind} sessionId={undefined}>
          <p>{context.paneId}</p>
        </PaneFrame>
      ),
    });
  }
  return registry;
}

/** The pane context, cast: the bodies above read only the pane id. */
function paneContextFor(pane: SessionPane): PaneContext {
  return { kind: pane.kind, entity: pane.entity, paneId: pane.paneId } as unknown as PaneContext;
}
