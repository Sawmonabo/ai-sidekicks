// The pane edges through the real pane layout in Chromium, pressed with a real keyboard and the
// browser's own mouse. An arrow moves a width edge its own way by one nudge of the text size and
// by the large step with Shift, the arrows reversed with the block on the left; Home and a
// double-click give the opening width back; and after each the edge reports the width drawn and
// its two limits. The stack divider stops at the terminal's floor and the row's. A larger text
// size moves every limit and the edge reports its size inside them. An edge taken out of its
// document mid-drag ends the drag: the layout is resizing nothing and no width is kept.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { letFramesPass } from "../../helpers/animation-frame.js";
import { bridgeWrapper } from "../../helpers/app/frame-fixtures.js";
import { renderSettled } from "../../helpers/app/harness.js";
import { layoutPaneContext } from "../../helpers/pane-context.js";
import { RealMouse, type ViewportPoint } from "../real-mouse.js";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { SessionPaneLayout } from "#renderer/features/sessions/pane-layout/components/SessionPaneLayout.js";
import { failOnPaneSizesRefusal } from "#renderer/features/sessions/pane-layout/kept-sizes.test-support.js";
import { PaneLayoutStore } from "#renderer/features/sessions/pane-layout/store.js";
import { PANE_WIDTH_RULE_BY_KIND } from "#renderer/features/sessions/pane-layout/widths.js";
import { PaneRegistry } from "#renderer/registries/panes/registry.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { openStore } from "#renderer/store/persistence/ui-state-store.test-support.js";
import { type UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import {
  CONVERSATION_FLOOR_REM,
  PANE_EDGE_LARGE_STEP_REM,
  PANE_EDGE_STEP_REM,
  PANE_ROW_HEIGHT_FLOOR_REM,
  TERMINAL_PANE_HEIGHT_FLOOR_REM,
} from "#renderer/styles/palette.js";
import { DEFAULT_APPEARANCE_RECORD, TEXT_SIZES } from "#shared/appearance.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";

/** The box the layout is drawn in, wide enough that Preview opens at its own width. */
const LAYOUT_WIDTH_PX = 1400;
const LAYOUT_HEIGHT_PX = 700;
/** The root's size at the default text size, which every rem below is read against. */
const ROOT_PX = DEFAULT_APPEARANCE_RECORD.textSize;
const LARGEST_TEXT_SIZE = TEXT_SIZES.reduce((largest, size) => (size > largest ? size : largest));
/** Enough large steps to carry any edge here from one limit past the other. */
const PRESSES_PAST_A_LIMIT = 12;
/** How far the edge is dragged before its pane is closed under the hand, in CSS pixels. */
const DRAG_TRAVEL_PX = 60;

let mouse: RealMouse | undefined;
let pressedAt: ViewportPoint | undefined;

afterEach(async () => {
  // A case that failed with the button down lets it go, so the next case's mouse starts up.
  if (mouse !== undefined && pressedAt !== undefined) {
    await mouse.release(pressedAt);
  }
  mouse = undefined;
  pressedAt = undefined;
  cleanup();
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
});

describe("browser — a pane's width edge", () => {
  it("steps by a nudge and by the large step with Shift, each its own way, and resets", async () => {
    const layout = new PaneLayoutStore();
    const previewId = layout.open({ kind: "browser" });
    await mountLayout(layout);
    const opening = PANE_WIDTH_RULE_BY_KIND.browser.widthRem * ROOT_PX;
    const limits = {
      minimum: PANE_WIDTH_RULE_BY_KIND.browser.floorRem * ROOT_PX,
      maximum: LAYOUT_WIDTH_PX - CONVERSATION_FLOOR_REM * ROOT_PX,
    };
    const nudge = PANE_EDGE_STEP_REM * ROOT_PX;
    const largeStep = PANE_EDGE_LARGE_STEP_REM * ROOT_PX;
    const edge = widthEdgeOf("browser");
    expect(readingOf(edge)).toStrictEqual({ now: opening, ...limits });

    // With the block on the right its edge stands on the pane's left, and `←` grows the pane.
    await pressOn(edge, "{ArrowLeft}");
    expectDrawn(edge, opening + nudge, limits);
    await pressOn(edge, "{Shift>}{ArrowLeft}{/Shift}");
    expectDrawn(edge, opening + nudge + largeStep, limits);
    await pressOn(edge, "{ArrowRight}");
    expectDrawn(edge, opening + largeStep, limits);
    await pressOn(edge, "{Home}");
    expectDrawn(edge, opening, limits);

    await pressOn(edge, "{Shift>}{ArrowRight}{/Shift}");
    expectDrawn(edge, opening - largeStep, limits);
    await act(async () => {
      await userEvent.dblClick(edge);
    });
    expectDrawn(edge, opening, limits);

    // With the block on the left the edge stands on the pane's right, and `→` grows it.
    act(() => {
      layout.moveBlockAcross(previewId);
    });
    const leftEdge = widthEdgeOf("browser");
    await pressOn(leftEdge, "{ArrowRight}");
    expectDrawn(leftEdge, opening + nudge, limits);
    await pressOn(leftEdge, "{Shift>}{ArrowLeft}{/Shift}");
    expectDrawn(leftEdge, opening + nudge - largeStep, limits);
  });

  it("reports the limits of a larger text size, its size held inside them", async () => {
    const layout = new PaneLayoutStore();
    layout.open({ kind: "browser" });
    await mountLayout(layout);
    const edge = widthEdgeOf("browser");
    // Grown to the widest the conversation's floor allows at the default text size.
    await pressOn(edge, "{Shift>}{ArrowLeft}{/Shift}".repeat(PRESSES_PAST_A_LIMIT));
    const atDefault = readingOf(edge);
    expect(atDefault.now).toBe(atDefault.maximum);

    act(() => {
      applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, textSize: LARGEST_TEXT_SIZE });
    });
    await letFramesPass(2);

    const atLargest = readingOf(edge);
    expect(atLargest.minimum).toBe(
      Math.round(PANE_WIDTH_RULE_BY_KIND.browser.floorRem * LARGEST_TEXT_SIZE),
    );
    expect(atLargest.maximum).toBe(
      Math.round(LAYOUT_WIDTH_PX - CONVERSATION_FLOOR_REM * LARGEST_TEXT_SIZE),
    );
    expect(atLargest.now).toBe(atLargest.maximum);
    expect(atLargest.now).toBeLessThan(atDefault.now);
  });

  it("ends a drag whose edge is taken out of its document, keeping no width", async () => {
    const layout = new PaneLayoutStore();
    const previewId = layout.open({ kind: "browser" });
    const uiStateStore = openStore();
    const { container } = await mountLayout(layout, uiStateStore);
    const paneLayout =
      container.querySelector<HTMLElement>(".meridian-pane-layout") ??
      expect.fail("the layout is drawn");

    mouse = await RealMouse.calibrated(document);
    const box = widthEdgeOf("browser").getBoundingClientRect();
    const from = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const to = { x: from.x - DRAG_TRAVEL_PX, y: from.y };
    const heldMouse = mouse;
    await act(async () => {
      await heldMouse.press(from);
      pressedAt = from;
      await heldMouse.dragTo(from, to, 6);
      pressedAt = to;
    });
    // Negative control: while the edge is held, the layout is resizing.
    expect(paneLayout.dataset["resizing"]).toBe("");

    act(() => {
      layout.close(previewId);
    });
    await letFramesPass(2);
    expect(paneLayout.dataset["resizing"]).toBeUndefined();

    await act(async () => {
      await heldMouse.release(to);
    });
    pressedAt = undefined;
    expect(await uiStateStore.readGlobal("pane-sizes")).toBeUndefined();
  });
});

describe("browser — the stack divider", () => {
  it("stops at the terminal's floor and at the row's", async () => {
    const layout = new PaneLayoutStore();
    layout.open({ kind: "browser" });
    layout.open({ kind: "terminal" });
    const { container } = await mountLayout(layout);
    const terminalSlot =
      container.querySelector<HTMLElement>('[data-placement="terminal-stacked"]') ??
      expect.fail("the terminal is stacked under the row");
    const row =
      container.querySelector<HTMLElement>(".meridian-pane-layout__row") ??
      expect.fail("the row is drawn");
    const divider =
      terminalSlot.querySelector<HTMLElement>(".meridian-pane-edge") ??
      expect.fail("the stacked terminal draws its divider");
    const terminalFloor = TERMINAL_PANE_HEIGHT_FLOOR_REM * ROOT_PX;
    const rowFloor = PANE_ROW_HEIGHT_FLOOR_REM * ROOT_PX;

    // Under the row, `↑` grows the terminal.
    await pressOn(divider, "{Shift>}{ArrowUp}{/Shift}".repeat(PRESSES_PAST_A_LIMIT));
    const grown = readingOf(divider);
    expect(grown.now).toBe(grown.maximum);
    expect(grown.maximum).toBe(Math.round(LAYOUT_HEIGHT_PX - rowFloor));
    expect(row.getBoundingClientRect().height).toBeCloseTo(rowFloor, 0);

    await pressOn(divider, "{Shift>}{ArrowDown}{/Shift}".repeat(PRESSES_PAST_A_LIMIT));
    const shrunk = readingOf(divider);
    expect(shrunk.now).toBe(shrunk.minimum);
    expect(shrunk.minimum).toBe(Math.round(terminalFloor));
    expect(terminalSlot.getBoundingClientRect().height).toBeCloseTo(terminalFloor, 0);
  });
});

/** The real pane layout in a box of its own, Preview and the terminal framed with nothing in them. */
async function mountLayout(
  layout: PaneLayoutStore,
  uiStateStore: UiStateStore = openStore(),
): Promise<{ readonly container: HTMLElement }> {
  installMeridianTokens(document);
  const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
  const registry = new PaneRegistry();
  for (const kind of ["browser", "terminal"] as const) {
    registry.register({
      kind,
      owner: "pane-edges-test",
      render: () => <PaneFrame kind={kind} sessionId={undefined} />,
    });
  }
  const BridgeHost = bridgeWrapper(fixture.bridge);
  return renderSettled(
    <BridgeHost>
      <LiveAnnouncerProvider>
        <div
          style={{
            display: "grid",
            width: `${String(LAYOUT_WIDTH_PX)}px`,
            height: `${String(LAYOUT_HEIGHT_PX)}px`,
          }}
        >
          <SessionPaneLayout
            layout={layout}
            registry={registry}
            paneContextFor={(pane) =>
              layoutPaneContext(pane, { bridge: fixture.bridge, sessionStore: undefined })
            }
            isSessionOpen
            sessionId={undefined}
            conversation={<p>the conversation</p>}
            uiStateStore={uiStateStore}
            onPaneSizesRefused={failOnPaneSizesRefusal}
          />
        </div>
      </LiveAnnouncerProvider>
    </BridgeHost>,
  );
}

/** The width edge drawn on the open pane of `kind`. */
function widthEdgeOf(kind: "browser"): HTMLElement {
  const slot =
    document.querySelector(`.meridian-pane--${kind}`)?.closest(".meridian-pane-layout__pane") ??
    expect.fail(`no ${kind} pane is drawn`);
  return (
    slot.querySelector<HTMLElement>(":scope > .meridian-pane-edge") ??
    expect.fail(`the ${kind} pane draws no edge`)
  );
}

/** Focuses `edge` and presses `keys` on it, letting the layout draw what they set. */
async function pressOn(edge: HTMLElement, keys: string): Promise<void> {
  act(() => {
    edge.focus();
  });
  await act(async () => {
    await userEvent.keyboard(keys);
  });
}

/** What an edge reports: the size it sets and its two limits, as a screen reader reads them. */
function readingOf(edge: HTMLElement): {
  readonly now: number;
  readonly minimum: number;
  readonly maximum: number;
} {
  return {
    now: Number(edge.getAttribute("aria-valuenow")),
    minimum: Number(edge.getAttribute("aria-valuemin")),
    maximum: Number(edge.getAttribute("aria-valuemax")),
  };
}

/** The edge reports `widthPx` inside its limits, and its pane is drawn that wide. */
function expectDrawn(
  edge: HTMLElement,
  widthPx: number,
  limits: { readonly minimum: number; readonly maximum: number },
): void {
  expect(readingOf(edge)).toStrictEqual({
    now: Math.round(widthPx),
    minimum: Math.round(limits.minimum),
    maximum: Math.round(limits.maximum),
  });
  const slot = edge.closest(".meridian-pane-layout__pane") ?? expect.fail("the edge is in a slot");
  expect(slot.getBoundingClientRect().width).toBeCloseTo(widthPx, 0);
}
