// Reordering by dragging with a real pointer: the item rides the pointer by `transform`, the new
// order commits once on release, and Escape puts everything back with no commit. Real input goes
// in through the browser's own input pipeline (CDP `Input.dispatchMouseEvent`), because pointer
// capture holds only for a pointer whose button the browser itself saw pressed.
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
import { FixtureBridgeProvider } from "../helpers/app/frame-fixtures.js";
import { politeText } from "../helpers/live-region.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { PageTabStrip } from "#renderer/features/preview/components/PageTab/PageTabStrip.js";
import { previewPage } from "#renderer/features/preview/page-list-reading.test-support.js";
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

describe("browser — dragging to reorder", () => {
  it("carries a tab on the pointer, commits once on release, and Escape commits nothing", async () => {
    installMeridianTokens(document);
    const onReorder = vi.fn();
    const mount = await renderSettled(<ReorderingTabStrip onReorder={onReorder} />);
    const tabs = [...mount.container.querySelectorAll<HTMLElement>(".meridian-preview-tab")];
    const [first, , third] = tabs;
    if (first === undefined || third === undefined) {
      throw new Error("the strip drew fewer than three tabs");
    }
    const homeLefts = lefts(tabs);
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
    expect(onReorder).not.toHaveBeenCalled();

    await act(async () => {
      await mouse.release(carried);
      await nextFrame(window);
    });
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith("a", 2);

    // The new order arrived; every tab glides into its place and wears nothing afterwards.
    const settledTabs = [...mount.container.querySelectorAll<HTMLElement>(".meridian-preview-tab")];
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

    // Lift again and press Escape mid-drag: no commit, and the tab glides home.
    const second = settledTabs[0];
    if (second === undefined) {
      throw new Error("the strip lost its first tab");
    }
    const pressAgain = centerOf(second);
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
  });

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
    await mouse.press(press);
    await mouse.dragTo(press, carried, 12);
    await nextFrame(secondWindow);
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
    await glidesEnded(settledPanels);
    expect(settledPanels.map((panel) => panel.id)).toStrictEqual([secondPane, firstPane]);
    expect(settledPanels.map((panel) => panel.style.transform)).toStrictEqual(["", ""]);
  });
});

/** The tab strip over a page list it reorders itself, as the Preview act's reading would. */
function ReorderingTabStrip(props: {
  readonly onReorder: (pageId: string, toIndex: number) => void;
}): React.JSX.Element {
  const [pages, setPages] = useState(FOUR_PAGES);
  return (
    <PageTabStrip
      reading={{ kind: "served", frame: { pages, activeIndex: 0 } }}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onReorder={(pageId, toIndex) => {
        props.onReorder(pageId, toIndex);
        setPages((current) => {
          const moved = current.filter((page) => page.pageId !== pageId);
          const page = current.find((candidate) => candidate.pageId === pageId);
          return page === undefined ? current : moved.toSpliced(toIndex, 0, page);
        });
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
