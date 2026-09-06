// The tab strip: four readings, the two controls, and the drop arithmetic in place.
//
// The drag cases here are the ones `tab-reorder.test.ts` cannot make: that file proves
// `pageMoveIndex` computes the right number, and these prove the strip feeds it the
// right slot — a rightward drag, a leftward one, the trailing slot, and a drop of a
// payload naming a page this strip does not draw. A component that passed the drop
// slot straight through would still pass the arithmetic suite.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";

import { refuse } from "../../core/index.js";
import type { PageListReading } from "./page-state.js";
import { browserPage as page, threeBrowserPages } from "./page-state.test-support.js";
import { TabStrip, type TabStripProps } from "./TabStrip.js";
import { BROWSER_TAB_DRAG_MEDIA_TYPE } from "./tab-reorder.js";

const THREE_PAGES: PageListReading = threeBrowserPages();

/**
 * The four handlers, typed by the props they satisfy.
 *
 * `TabStripProps` supplies each signature, so a mock declared against it is checked
 * against the real contract — an untyped `vi.fn()` would satisfy nothing and a handler
 * renamed on the props would leave every assertion here passing against a component
 * that no longer takes it.
 */
interface StripHandlers {
  readonly onSelect: Mock<TabStripProps["onSelect"]>;
  readonly onClose: Mock<TabStripProps["onClose"]>;
  readonly onCreate: Mock<TabStripProps["onCreate"]>;
  readonly onReorder: Mock<TabStripProps["onReorder"]>;
}

function renderStrip(reading: PageListReading): StripHandlers {
  const handlers: StripHandlers = {
    onSelect: vi.fn<TabStripProps["onSelect"]>(),
    onClose: vi.fn<TabStripProps["onClose"]>(),
    onCreate: vi.fn<TabStripProps["onCreate"]>(),
    onReorder: vi.fn<TabStripProps["onReorder"]>(),
  };
  render(<TabStrip reading={reading} {...handlers} />);
  return handlers;
}

/** A `DataTransfer` stand-in: jsdom's drag events carry none of their own. */
function dragTransfer(pageId: string | undefined): DataTransfer {
  const held = new Map<string, string>();
  if (pageId !== undefined) {
    held.set(BROWSER_TAB_DRAG_MEDIA_TYPE, pageId);
  }
  return {
    types: [...held.keys()],
    dropEffect: "none",
    getData: (type: string): string => held.get(type) ?? "",
    setData: (type: string, value: string): void => {
      held.set(type, value);
    },
  } as unknown as DataTransfer;
}

function tabAt(index: number): HTMLElement {
  const tabs = document.querySelectorAll(".meridian-browser-tab");
  const tab = tabs[index];
  if (!(tab instanceof HTMLElement)) {
    throw new Error(`no tab drawn at slot ${String(index)}`);
  }
  return tab;
}

/** The face of the tab at a slot — the control that selects it. */
function tabFace(index: number): HTMLElement {
  const face = tabAt(index).querySelector(".meridian-browser-tab__face");
  if (!(face instanceof HTMLElement)) {
    throw new Error(`the tab at slot ${String(index)} drew no face`);
  }
  return face;
}

function trailingSlot(): HTMLElement {
  const tail = document.querySelector(".meridian-browser-tabs__tail");
  if (!(tail instanceof HTMLElement)) {
    throw new Error("the strip drew no trailing slot");
  }
  return tail;
}

describe("the tab strip's readings", () => {
  it("distinguishes an unread page list from an empty one", () => {
    renderStrip({ kind: "reading" });
    const label = screen.getByText("Pages not read");
    expect(screen.queryByText("No pages open")).toBeNull();
    // A badge has room for one line, so its second sentence rides the tooltip — and
    // that sentence is the DENIAL rather than a restatement: without it the badge
    // says only that nothing answered, and a person reading a strip with no tabs in
    // it supplies the missing half themselves, wrongly.
    expect(label.getAttribute("title")).toContain("Nothing here says this session owns no pages");
  });

  it("says the producer finished rather than that the pages closed", () => {
    renderStrip({ kind: "ended" });
    expect(screen.getByText("Pages no longer reported")).toBeTruthy();
  });

  it("renders a refused list as a refusal", () => {
    renderStrip({
      kind: "refused",
      scope: "whole-answer",
      refusal: refuse("browser-pages", "page-subscription-failed", "The subscription broke."),
    });
    expect(screen.getByText(/The subscription broke\./)).toBeTruthy();
  });

  it("says the session owns no pages only where it owns none", () => {
    renderStrip({ kind: "served", frame: { contextName: null, pages: [] } });
    expect(screen.getByText("No pages open")).toBeTruthy();
    expect(screen.getByText("Unnamed context")).toBeTruthy();
  });

  it("renders the agent's context name where it set one", () => {
    renderStrip(THREE_PAGES);
    expect(screen.getByText("Research")).toBeTruthy();
  });

  it("marks a background page and a loading one from the reported frame", () => {
    renderStrip({
      kind: "served",
      frame: {
        contextName: null,
        pages: [page({ pageId: "page-a", isLoading: true, isShown: false, isSelected: true })],
      },
    });
    expect(screen.getByText("Loading")).toBeTruthy();
    expect(screen.getByText("background")).toBeTruthy();
    expect(tabFace(0).getAttribute("aria-current")).toBe("true");
  });

  it("marks the selected tab with a class the stylesheet can key on", () => {
    // `aria-current` sits on the FACE, because that is the interactive element — so a
    // rule keyed on the tab ITEM's own `aria-current` matches nothing and the selected
    // tab is drawn like every other one. No unit tier can see that, because no cascade
    // runs here; what this case holds is the hook the browser tier then resolves.
    renderStrip(THREE_PAGES);
    expect(tabAt(0).className).toContain("meridian-browser-tab--selected");
    expect(tabAt(1).className).not.toContain("meridian-browser-tab--selected");
  });
});

describe("the tab strip's controls", () => {
  it("selects, closes, and creates through the acts it was handed", () => {
    const handlers = renderStrip(THREE_PAGES);
    fireEvent.click(tabFace(1));
    fireEvent.click(screen.getByRole("button", { name: "Close Title page-c" }));
    fireEvent.click(screen.getByRole("button", { name: "New page" }));
    expect(handlers.onSelect).toHaveBeenCalledWith("page-b");
    expect(handlers.onClose).toHaveBeenCalledWith("page-c");
    expect(handlers.onCreate).toHaveBeenCalledOnce();
  });
});

describe("dropping a dragged tab", () => {
  it("subtracts one for a rightward drop, so the tab lands where it was dropped", () => {
    const handlers = renderStrip(THREE_PAGES);
    fireEvent.drop(tabAt(2), { dataTransfer: dragTransfer("page-a") });
    expect(handlers.onReorder).toHaveBeenCalledWith("page-a", 1);
  });

  it("subtracts nothing for a leftward drop", () => {
    const handlers = renderStrip(THREE_PAGES);
    fireEvent.drop(tabAt(0), { dataTransfer: dragTransfer("page-c") });
    expect(handlers.onReorder).toHaveBeenCalledWith("page-c", 0);
  });

  it("reaches the last position through the trailing slot", () => {
    const handlers = renderStrip(THREE_PAGES);
    fireEvent.drop(trailingSlot(), { dataTransfer: dragTransfer("page-a") });
    expect(handlers.onReorder).toHaveBeenCalledWith("page-a", 2);
  });

  it("dispatches nothing for a drop onto the tab's own slot", () => {
    const handlers = renderStrip(THREE_PAGES);
    fireEvent.drop(tabAt(1), { dataTransfer: dragTransfer("page-b") });
    expect(handlers.onReorder).not.toHaveBeenCalled();
  });

  it("dispatches nothing for a payload naming a page this strip does not draw", () => {
    const handlers = renderStrip(THREE_PAGES);
    fireEvent.drop(tabAt(0), { dataTransfer: dragTransfer("page-from-another-pane") });
    expect(handlers.onReorder).not.toHaveBeenCalled();
  });

  it("dispatches nothing for a drag carrying no tab payload at all", () => {
    const handlers = renderStrip(THREE_PAGES);
    fireEvent.drop(tabAt(0), { dataTransfer: dragTransfer(undefined) });
    expect(handlers.onReorder).not.toHaveBeenCalled();
  });

  it("paints the drop marker only while a tab drag is over a slot", () => {
    renderStrip(THREE_PAGES);
    const target = tabAt(1);
    expect(target.className).not.toContain("drop-before");
    fireEvent.dragOver(target, { dataTransfer: dragTransfer("page-a") });
    expect(tabAt(1).className).toContain("drop-before");
    fireEvent.drop(target, { dataTransfer: dragTransfer("page-a") });
    expect(tabAt(1).className).not.toContain("drop-before");
  });

  it("does not become a drop target for a drag that is not a tab", () => {
    renderStrip(THREE_PAGES);
    fireEvent.dragOver(tabAt(1), { dataTransfer: dragTransfer(undefined) });
    expect(tabAt(1).className).not.toContain("drop-before");
  });
});
