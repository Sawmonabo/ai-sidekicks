// The tab strip: what a served frame marks, its controls, and the drop arithmetic in place.
//
// The drag cases here are the ones `tab-reorder.test.ts` cannot make: that file proves
// `pageMoveIndex` computes the right number, and these prove the strip feeds it the
// right slot — a rightward drag, a leftward one, the trailing slot, and a drop of a
// payload naming a page this strip does not draw. A component that passed the drop
// slot straight through would still pass the arithmetic suite.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";

import type { PageListReading } from "../page-list-reading.js";
import { previewPage as page, threeBrowserPages } from "../page-list-reading.test-support.js";
import { TabStrip, type PageTabStripProps } from "./PageTabStrip.js";
import { BROWSER_TAB_DRAG_MEDIA_TYPE } from "../tab-reorder.js";

const THREE_PAGES: PageListReading = threeBrowserPages();

/**
 * The three handlers, typed by the props they satisfy.
 *
 * `PageTabStripProps` supplies each signature, so a mock declared against it is checked
 * against the real contract — an untyped `vi.fn()` would satisfy nothing and a handler
 * renamed on the props would leave every assertion here passing against a component
 * that no longer takes it.
 */
interface StripHandlers {
  readonly onSelect: Mock<PageTabStripProps["onSelect"]>;
  readonly onClose: Mock<PageTabStripProps["onClose"]>;
  readonly onReorder: Mock<PageTabStripProps["onReorder"]>;
}

function renderStrip(reading: PageListReading): StripHandlers {
  const handlers: StripHandlers = {
    onSelect: vi.fn<PageTabStripProps["onSelect"]>(),
    onClose: vi.fn<PageTabStripProps["onClose"]>(),
    onReorder: vi.fn<PageTabStripProps["onReorder"]>(),
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

describe("the tab strip's frame", () => {
  it("marks the active page and a loading one from the reported frame", () => {
    renderStrip({
      kind: "served",
      frame: {
        pages: [page({ pageId: "page-a", isLoading: true }), page({ pageId: "page-b" })],
        activeIndex: 0,
      },
    });
    expect(screen.getByText("Loading")).toBeTruthy();
    // `"page"` and not `"true"`: the strip is a set of pages and `aria-current` has a
    // token for exactly that, which tells a screen reader WHICH kind of current this
    // is rather than only that something is.
    expect(tabFace(0).getAttribute("aria-current")).toBe("page");
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

describe("the tab strip's presence", () => {
  it("draws nothing for one page, and a strip for two", () => {
    const one = render(
      <TabStrip
        reading={{ kind: "served", frame: { pages: [page({ pageId: "a" })], activeIndex: 0 } }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    expect(one.container.querySelector(".meridian-browser-tabs")).toBeNull();
    one.unmount();
    renderStrip({
      kind: "served",
      frame: { pages: [page({ pageId: "a" }), page({ pageId: "b" })], activeIndex: 0 },
    });
    expect(document.querySelectorAll(".meridian-browser-tab")).toHaveLength(2);
  });
});

describe("the tab strip's controls", () => {
  it("selects and closes through the acts it was handed", () => {
    const handlers = renderStrip(THREE_PAGES);
    fireEvent.click(tabFace(1));
    fireEvent.click(screen.getByRole("button", { name: "Close Title page-c" }));
    expect(handlers.onSelect).toHaveBeenCalledWith("page-b");
    expect(handlers.onClose).toHaveBeenCalledWith("page-c");
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
