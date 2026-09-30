// Dragging a pane. The key cases are drops that must commit nothing: a drag that ended over no
// pane, and a payload that belongs to somebody else's draggable.
//
// Drop arithmetic is tested against the real `dropPosition`, not a copy. The settlement is
// driven through `commitPaneDrop` because jsdom implements neither `DragEvent` nor
// `DataTransfer`, so the library's gesture cannot run here.

import { describe, expect, it } from "vitest";

import type {
  Announce,
  AnnouncementPoliteness,
} from "@renderer/components/LiveAnnouncer/live-announcer.js";
import { PANE_LAYOUT_RESTORED_PANE_CAP, PaneLayoutStore } from "./pane-layout-store.js";
import {
  PANE_LAYOUT_DRAG_KEY,
  PaneLayoutDragCoordinator,
  commitPaneDrop,
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
  it("recognizes a pane drag by its namespaced key", () => {
    expect(paneIdFromDragData({ [PANE_LAYOUT_DRAG_KEY]: "pane-2" })).toBe("pane-2");
  });

  it("negative control: somebody else's draggable is not a pane drag", () => {
    // Otherwise the monitor would act on every element drag on the page.
    expect(paneIdFromDragData({ transcriptRowId: "row-9" })).toBeUndefined();
    expect(paneIdFromDragData({ [PANE_LAYOUT_DRAG_KEY]: 7 })).toBeUndefined();
  });
});

describe("which edge a pointer is over", () => {
  it("answers before on the near half and after on the far half", () => {
    const pane = elementSpanning(100, 200);
    expect(dropEdgeFor(pane, 120)).toBe("before");
    expect(dropEdgeFor(pane, 280)).toBe("after");
  });

  it("negative control: the answer is not the same on both halves", () => {
    // An edge test that always answered "after" would pass the case above by half.
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
    // "After pane-3" is index 3 in the untouched row and 2 once pane-1 is lifted out.
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
    const coordinator = new PaneLayoutDragCoordinator();
    const published: (string | undefined)[] = [];
    coordinator.subscribe((indicator) => published.push(indicator?.overPaneId));

    coordinator.hover({ overPaneId: "pane-2", edge: "before" });
    coordinator.hover({ overPaneId: "pane-2", edge: "before" });
    coordinator.hover({ overPaneId: "pane-2", edge: "after" });

    expect(published).toStrictEqual(["pane-2", "pane-2"]);
  });

  it("negative control: clearing an empty indicator publishes nothing", () => {
    // A coordinator publishing on every call would re-render on every frame of a drag.
    const coordinator = new PaneLayoutDragCoordinator();
    const published: (string | undefined)[] = [];
    coordinator.subscribe((indicator) => published.push(indicator?.overPaneId));
    coordinator.clear();
    expect(published).toStrictEqual([]);
  });

  it("forgets both the indicator and the pane in the air when a drag ends", () => {
    const coordinator = new PaneLayoutDragCoordinator();
    coordinator.startDrag("pane-1");
    coordinator.hover({ overPaneId: "pane-2", edge: "after" });
    expect(coordinator.draggedPaneId).toBe("pane-1");

    coordinator.clear();

    expect(coordinator.snapshot()).toBeUndefined();
    expect(coordinator.draggedPaneId).toBeUndefined();
  });
});

interface RecordedAnnouncement {
  readonly message: string;
  readonly politeness: AnnouncementPoliteness;
}

/** A sink shaped like the announcer's that records the lane the settlement asked for. */
function recordingAnnounce(): { announce: Announce; recorded: RecordedAnnouncement[] } {
  const recorded: RecordedAnnouncement[] = [];
  const announce: Announce = (message, politeness = "polite") => {
    recorded.push({ message, politeness });
  };
  return { announce, recorded };
}

/** Three panes in order, `pane-1` to `pane-3`, so a drop has room to move. */
function threePaneLayout(): PaneLayoutStore {
  const layout = new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
  layout.open({ kind: "transcript" });
  layout.open({ kind: "terminal" });
  layout.open({ kind: "agents" });
  return layout;
}

describe("what a settled drop says out loud", () => {
  it("names where the pane landed, politely, and moves it there", () => {
    const layout = threePaneLayout();
    const { announce, recorded } = recordingAnnounce();

    commitPaneDrop(layout, "pane-1", { overPaneId: "pane-3", edge: "after" }, announce);

    expect(layout.snapshot().panes.map((pane) => pane.paneId)).toStrictEqual([
      "pane-2",
      "pane-3",
      "pane-1",
    ]);
    expect(recorded).toStrictEqual([
      { message: "Moved the Transcript pane to position 3 of 3.", politeness: "polite" },
    ]);
  });

  it("says a drop released over nothing moved nothing, in the lane that interrupts", () => {
    // No visual trace: the layout looks unchanged, so silence would look like an unseen move.
    const layout = threePaneLayout();
    const { announce, recorded } = recordingAnnounce();

    commitPaneDrop(layout, "pane-1", undefined, announce);

    expect(layout.snapshot().panes.map((pane) => pane.paneId)).toStrictEqual([
      "pane-1",
      "pane-2",
      "pane-3",
    ]);
    expect(recorded).toStrictEqual([
      { message: "The Transcript pane was not moved.", politeness: "assertive" },
    ]);
  });

  it("calls a drop onto the position it already held a non-move, not a move", () => {
    // "Before the pane on my right" is the index the pane already holds, so `dropPosition`
    // answers and the reorder no-ops; announcing a move here would be false.
    const layout = threePaneLayout();
    const { announce, recorded } = recordingAnnounce();

    commitPaneDrop(layout, "pane-1", { overPaneId: "pane-2", edge: "before" }, announce);

    expect(layout.snapshot().panes.map((pane) => pane.paneId)).toStrictEqual([
      "pane-1",
      "pane-2",
      "pane-3",
    ]);
    expect(recorded).toStrictEqual([
      { message: "The Transcript pane was not moved.", politeness: "assertive" },
    ]);
  });

  it("negative control: a drag that is not a pane of this pane layout's says nothing at all", () => {
    // The cases above would also pass over a settlement that announced on every drag end,
    // including somebody else's draggable and a pane closed while in the air.
    const layout = threePaneLayout();
    const { announce, recorded } = recordingAnnounce();

    commitPaneDrop(layout, undefined, { overPaneId: "pane-2", edge: "after" }, announce);
    commitPaneDrop(layout, "pane-9", { overPaneId: "pane-2", edge: "after" }, announce);

    expect(recorded).toStrictEqual([]);
    expect(layout.snapshot().panes.map((pane) => pane.paneId)).toStrictEqual([
      "pane-1",
      "pane-2",
      "pane-3",
    ]);
  });
});
