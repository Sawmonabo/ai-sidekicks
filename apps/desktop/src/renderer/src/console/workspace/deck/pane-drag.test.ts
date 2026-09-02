// Dragging a pane, and the two ways a drop can be wrong.
//
// The cases that carry weight are the ones where a drop must commit NOTHING: a drag
// that ended over no pane, and a drag whose payload belongs to somebody else's
// draggable. Both leave the deck exactly as it was, and a coordinator that quietly
// dropped onto the last pane it saw would look identical until a person did it.
//
// The drop position arithmetic is tested against the same function the drop handler
// calls, never against a copy of it: the off-by-one in "drop after a pane that sits
// to my right" is the whole of the rule, and a second implementation of it in a test
// would agree with itself and with nothing else.

import { describe, expect, it } from "vitest";

import {
  DECK_PANE_DRAG_KEY,
  DeckDragCoordinator,
  dropEdgeFor,
  dropPosition,
  paneIdFromDragData,
} from "./pane-drag.js";

/** An element that reports the given horizontal band, the one thing the edge test reads. */
function elementSpanning(left: number, width: number): Element {
  const element = document.createElement("div");
  element.getBoundingClientRect = (): DOMRect =>
    ({ left, width, right: left + width, top: 0, bottom: 0, height: 0, x: left, y: 0 }) as DOMRect;
  return element;
}

describe("reading a drag payload", () => {
  it("recognises a pane drag by its namespaced key", () => {
    expect(paneIdFromDragData({ [DECK_PANE_DRAG_KEY]: "pane-2" })).toBe("pane-2");
  });

  it("negative control: somebody else's draggable is not a pane drag", () => {
    // Without this the deck's monitor would act on every element drag on the page,
    // including a ledger row somebody made draggable later.
    expect(paneIdFromDragData({ ledgerRowId: "row-9" })).toBeUndefined();
    expect(paneIdFromDragData({ [DECK_PANE_DRAG_KEY]: 7 })).toBeUndefined();
  });
});

describe("which edge a pointer is over", () => {
  it("answers before on the near half and after on the far half", () => {
    const pane = elementSpanning(100, 200);
    expect(dropEdgeFor(pane, 120)).toBe("before");
    expect(dropEdgeFor(pane, 280)).toBe("after");
  });

  it("negative control: the answer is not the same on both halves", () => {
    // Without this an edge test that always answered "after" would pass the case
    // above by half, and every drop would land on one side of its target.
    const pane = elementSpanning(0, 100);
    expect(dropEdgeFor(pane, 10)).not.toBe(dropEdgeFor(pane, 90));
  });
});

describe("where a drop lands", () => {
  const paneIds = ["pane-1", "pane-2", "pane-3"];

  it("inserts before a target to the left without shifting for the removal", () => {
    expect(dropPosition(paneIds, "pane-3", "pane-1", "before")).toBe(0);
    expect(dropPosition(paneIds, "pane-3", "pane-1", "after")).toBe(1);
  });

  it("shifts left by one for a target that sat to the right of the dragged pane", () => {
    // "After pane-3" is index 3 in the untouched row and index 2 once pane-1 has
    // been lifted out of it. Getting this wrong puts the pane one place short.
    expect(dropPosition(paneIds, "pane-1", "pane-3", "after")).toBe(2);
    expect(dropPosition(paneIds, "pane-1", "pane-2", "before")).toBe(0);
  });

  it("negative control: a pane dropped on itself, or on a stranger, lands nowhere", () => {
    expect(dropPosition(paneIds, "pane-2", "pane-2", "after")).toBeUndefined();
    expect(dropPosition(paneIds, "pane-2", "pane-9", "after")).toBeUndefined();
    expect(dropPosition(paneIds, "pane-9", "pane-2", "after")).toBeUndefined();
  });
});

describe("the drag coordinator", () => {
  it("publishes once per real move and not at all for a hover that changes nothing", () => {
    const coordinator = new DeckDragCoordinator();
    const published: (string | undefined)[] = [];
    coordinator.subscribe((indicator) => published.push(indicator?.overPaneId));

    coordinator.hover({ overPaneId: "pane-2", edge: "before" });
    coordinator.hover({ overPaneId: "pane-2", edge: "before" });
    coordinator.hover({ overPaneId: "pane-2", edge: "after" });

    expect(published).toStrictEqual(["pane-2", "pane-2"]);
  });

  it("negative control: clearing an empty indicator publishes nothing", () => {
    // Without this the coordinator could be publishing on every call, which would
    // re-render the deck for every frame of a drag that crossed no midpoint.
    const coordinator = new DeckDragCoordinator();
    const published: (string | undefined)[] = [];
    coordinator.subscribe((indicator) => published.push(indicator?.overPaneId));
    coordinator.clear();
    expect(published).toStrictEqual([]);
  });

  it("forgets both the indicator and the pane in the air when a drag ends", () => {
    const coordinator = new DeckDragCoordinator();
    coordinator.startDrag("pane-1");
    coordinator.hover({ overPaneId: "pane-2", edge: "after" });
    expect(coordinator.draggedPaneId).toBe("pane-1");

    coordinator.clear();

    expect(coordinator.snapshot()).toBeUndefined();
    expect(coordinator.draggedPaneId).toBeUndefined();
  });
});
