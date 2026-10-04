// The layout as it moves: what one entity opens, what order and focus do, and what the panel
// group's settled sizes may change. Snapshots are in `pane-layout-store.snapshot.test.ts`.

import { describe, expect, it } from "vitest";

import { PANE_LAYOUT_RESTORED_PANE_CAP } from "./pane-layout-store.js";
import { PaneLayoutStore } from "./pane-layout-store.js";
import { PANE_LAYOUT_TOTAL_PERMILLE } from "./pane-layout.js";

function emptyLayout(): PaneLayoutStore {
  return new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
}

/** A layout holding one session-scoped transcript and one worktree-scoped inspector. */
function twoPaneLayout(): PaneLayoutStore {
  const layout = emptyLayout();
  layout.open({ kind: "transcript" });
  layout.open({ kind: "inspector", entity: { kind: "worktree", id: "worktree-01" } });
  return layout;
}

describe("PaneLayoutStore — one entity, one pane", () => {
  it("focuses the pane that already shows an entity rather than opening a second", () => {
    const layout = emptyLayout();
    const first = layout.open({
      kind: "inspector",
      entity: { kind: "worktree", id: "worktree-01" },
    });
    const second = layout.open({
      kind: "inspector",
      entity: { kind: "worktree", id: "worktree-01" },
    });

    expect(second).toBe(first);
    expect(layout.snapshot().panes).toHaveLength(1);
    expect(layout.snapshot().focusedPaneId).toBe(first);
  });

  it("negative control: the same entity in a different KIND of pane opens a second", () => {
    // The case above would also pass over a layout that refused every second open; a worktree
    // appears in both an inspector and a diff pane.
    const layout = emptyLayout();
    layout.open({ kind: "inspector", entity: { kind: "worktree", id: "worktree-01" } });
    layout.open({ kind: "diff", entity: { kind: "worktree", id: "worktree-01" } });
    expect(layout.snapshot().panes).toHaveLength(2);
  });
});

describe("PaneLayoutStore — order, focus, and the ephemeral cascade", () => {
  it("opens a pane beside its source rather than at the end", () => {
    const layout = twoPaneLayout();
    const [first] = layout.snapshot().panes;
    layout.open(
      { kind: "browser" },
      first === undefined ? undefined : { linkedSourcePaneId: first.paneId },
    );
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "transcript",
      "browser",
      "inspector",
    ]);
  });

  it("closes an ephemeral pane with the pane it opened beside", () => {
    const layout = twoPaneLayout();
    const source = layout.snapshot().panes[0];
    if (source === undefined) {
      throw new Error("the fixture opened no panes");
    }
    layout.open({ kind: "browser" }, { linkedSourcePaneId: source.paneId });
    layout.close(source.paneId);
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual(["inspector"]);
  });

  it("negative control: closing a pane leaves a browser opened beside a DIFFERENT one", () => {
    const layout = twoPaneLayout();
    const [source, other] = layout.snapshot().panes;
    if (source === undefined || other === undefined) {
      throw new Error("the fixture opened too few panes");
    }
    layout.open({ kind: "browser" }, { linkedSourcePaneId: other.paneId });
    layout.close(source.paneId);
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "inspector",
      "browser",
    ]);
  });

  it("cycles focus in both directions, wrapping at each end", () => {
    const layout = twoPaneLayout();
    const [first, second] = layout.snapshot().panes;
    layout.focus(first?.paneId ?? "");
    layout.focusAdjacent(1);
    expect(layout.snapshot().focusedPaneId).toBe(second?.paneId);
    layout.focusAdjacent(1);
    expect(layout.snapshot().focusedPaneId).toBe(first?.paneId);
    layout.focusAdjacent(-1);
    expect(layout.snapshot().focusedPaneId).toBe(second?.paneId);
  });

  it("moves a pane one position and stops at the ends", () => {
    const layout = twoPaneLayout();
    const [first] = layout.snapshot().panes;
    // Counted, because a move past the end reorders into the same order: only the change it
    // announces, which the persistence hook writes to disk, tells it apart from staying put.
    let changes = 0;
    layout.subscribe(() => {
      changes += 1;
    });
    layout.movePane(first?.paneId ?? "", 1);
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "inspector",
      "transcript",
    ]);
    layout.movePane(first?.paneId ?? "", 1);
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "inspector",
      "transcript",
    ]);
    expect(changes).toBe(1);
  });
});

describe("PaneLayoutStore — adopting what the panel group settled on", () => {
  it(
    "takes the group's percentages as the pane layout's widths, " + "still summing to the total",
    () => {
      const layout = twoPaneLayout();
      layout.open({ kind: "terminal" });
      const paneIds = layout.snapshot().panes.map((pane) => pane.paneId);

      layout.applyLayout(
        { [paneIds[0] ?? ""]: 50, [paneIds[1] ?? ""]: 30, [paneIds[2] ?? ""]: 20 },
        0,
      );

      const after = layout.snapshot().panes.map((pane) => pane.sizePermille);
      expect(after).toStrictEqual([500, 300, 200]);
      expect(after.reduce((sum, size) => sum + size, 0)).toBe(PANE_LAYOUT_TOTAL_PERMILLE);
    },
  );

  it("clamps a width below the floor IN THE STORE, whatever the DOM reported", () => {
    // The subject is the persisted value: a width below the floor would be saved and restored
    // on the next launch, when the library's own clamp is not running.
    const layout = twoPaneLayout();
    const paneIds = layout.snapshot().panes.map((pane) => pane.paneId);
    const floorPermille = 400;

    layout.applyLayout({ [paneIds[0] ?? ""]: 95, [paneIds[1] ?? ""]: 5 }, floorPermille);

    const after = layout.snapshot().panes.map((pane) => pane.sizePermille);
    expect(Math.min(...after)).toBeGreaterThanOrEqual(floorPermille);
    expect(after.reduce((sum, size) => sum + size, 0)).toBe(PANE_LAYOUT_TOTAL_PERMILLE);
  });

  it("negative control: with no floor the same layout is adopted unclamped", () => {
    // The case above would also pass over a store that clamped every width to a fixed minimum.
    const layout = twoPaneLayout();
    const paneIds = layout.snapshot().panes.map((pane) => pane.paneId);
    layout.applyLayout({ [paneIds[0] ?? ""]: 95, [paneIds[1] ?? ""]: 5 }, 0);
    expect(layout.snapshot().panes.map((pane) => pane.sizePermille)).toStrictEqual([950, 50]);
  });

  it("negative control: a report that changes nothing raises no revision", () => {
    // Stops the write-back looping: the group reports after every commit, including its own.
    const layout = twoPaneLayout();
    const revisionBefore = layout.snapshot().revision;
    const percentages = Object.fromEntries(
      layout.snapshot().panes.map((pane) => [pane.paneId, pane.sizePermille / 10]),
    );
    layout.applyLayout(percentages, 0);
    expect(layout.snapshot().revision).toBe(revisionBefore);
  });
});

describe("PaneLayoutStore — the split act", () => {
  it("splits the source pane and leaves every other pane's width alone", () => {
    // Three panes at a third each, then a browser opened beside the first: only that pane gives
    // up width.
    const layout = emptyLayout();
    layout.open({ kind: "transcript" });
    layout.open({ kind: "terminal" });
    layout.open({ kind: "agents" });
    const before = layout.snapshot().panes.map((pane) => pane.sizePermille);
    const source = layout.snapshot().panes[0];
    if (source === undefined) {
      throw new Error("the fixture opened no panes");
    }

    layout.open({ kind: "browser" }, { linkedSourcePaneId: source.paneId });

    const after = layout.snapshot().panes.map((pane) => pane.sizePermille);
    expect(after).toStrictEqual([
      (before[0] ?? 0) - Math.floor((before[0] ?? 0) / 2),
      Math.floor((before[0] ?? 0) / 2),
      before[1],
      before[2],
    ]);
    expect(after.reduce((total, size) => total + size, 0)).toBe(PANE_LAYOUT_TOTAL_PERMILLE);
  });

  it("negative control: an open naming no source re-divides the whole pane layout", () => {
    // The case above would also pass over a layout that never equalized; list placement (the
    // palette, a rail destination) is the common one.
    const layout = emptyLayout();
    layout.open({ kind: "transcript" });
    layout.open({ kind: "terminal" });
    layout.open({ kind: "agents" });
    expect(layout.snapshot().panes.map((pane) => pane.sizePermille)).toStrictEqual([334, 333, 333]);
  });

  it("falls back to the list placement when the source is too narrow to halve", () => {
    // A pane at one permille has no width to give, so the layout re-divides rather than
    // refusing the open.
    const layout = emptyLayout();
    layout.open({ kind: "transcript" });
    layout.open({ kind: "terminal" });
    const [first, second] = layout.snapshot().panes;
    if (first === undefined || second === undefined) {
      throw new Error("the fixture opened too few panes");
    }
    layout.applyLayout({ [first.paneId]: 0.1, [second.paneId]: 99.9 }, 0);
    expect(layout.snapshot().panes[0]?.sizePermille).toBe(1);

    layout.open({ kind: "browser" }, { linkedSourcePaneId: first.paneId });

    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "transcript",
      "browser",
      "terminal",
    ]);
    expect(layout.snapshot().panes.map((pane) => pane.sizePermille)).toStrictEqual([334, 333, 333]);
  });
});
