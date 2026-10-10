// What a saved pane layout carries and the ways a saved one can be wrong. An unknown version,
// unknown kind or invalid entity is dropped and reported as a value a view can render, never
// thrown; a second pane of one kind is dropped during decoding because `open()` cannot repair
// it. Live movement is in `store.test.ts`.

import { describe, expect, it } from "vitest";

import { PaneLayoutStore } from "./store.js";
import { PANE_LAYOUT_SNAPSHOT_VERSION, PANE_LAYOUT_SNAPSHOT_HEADER_KEY } from "./snapshot.js";

const WORKTREE = { kind: "worktree", id: "worktree-01" } as const;

/** Review, Preview, the inspector and the terminal, moved off every default a record can hold. */
function arrangedLayout(): PaneLayoutStore {
  const layout = new PaneLayoutStore();
  const review = layout.open({ kind: "diff", entity: WORKTREE });
  layout.open({ kind: "browser" }, { linkedSourcePaneId: review });
  const inspector = layout.open({ kind: "inspector", entity: WORKTREE });
  layout.open({ kind: "terminal" });
  layout.reorderPane(inspector, 0);
  // Past the conversation-facing end, so the block stands left of the conversation.
  layout.movePane(inspector, -1);
  layout.placeTerminal("above");
  layout.focus(review);
  return layout;
}

describe("what a snapshot carries", () => {
  it("round-trips the panes in order, the focus, the block's side and the terminal's place", () => {
    const layout = arrangedLayout();

    const restored = new PaneLayoutStore();
    const report = restored.restore(layout.toSnapshot());

    expect(report.refusals).toStrictEqual([]);
    const state = restored.snapshot();
    // Preview is an ordinary pane, kept like the others.
    expect(state.panes.map((pane) => pane.kind)).toStrictEqual([
      "inspector",
      "diff",
      "browser",
      "terminal",
    ]);
    expect(state.panes[0]?.entity).toStrictEqual(WORKTREE);
    expect(state.side).toBe("left");
    expect(state.terminalPlace).toBe("above");
    expect(state.focusedPaneId).toBe(layout.snapshot().focusedPaneId);
    // An id minted after a restore is never one a restored pane holds.
    const minted = restored.open({ kind: "agents" });
    expect(state.panes.map((pane) => pane.paneId)).not.toContain(minted);
  });
});

describe("what a restore refuses", () => {
  it("discards a snapshot of an unknown version whole", () => {
    // A half-restored layout hides which half went missing.
    const snapshot = arrangedLayout().toSnapshot();
    const header = snapshot[PANE_LAYOUT_SNAPSHOT_HEADER_KEY];
    if (header === undefined) {
      throw new Error("the snapshot carried no header");
    }
    header["version"] = PANE_LAYOUT_SNAPSHOT_VERSION + 1;

    const restored = new PaneLayoutStore();
    const report = restored.restore(snapshot);

    expect(restored.snapshot().panes).toStrictEqual([]);
    expect(restored.snapshot().side).toBe("right");
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual([
      "snapshot-version-unknown",
    ]);
  });

  it("drops each pane it cannot believe and keeps the rest", () => {
    const snapshot = arrangedLayout().toSnapshot();
    snapshot["pane-91"] = { position: 5, kind: "holodeck" };
    // The transcript is the conversation's, never a pane in the block.
    snapshot["pane-92"] = { position: 6, kind: "transcript" };
    // Half an entity is not guessed at.
    snapshot["pane-93"] = { position: 7, kind: "agents", entityId: "agent-02" };
    // A second Review: one pane per kind, the first in position order kept.
    snapshot["pane-94"] = {
      position: 8,
      kind: "diff",
      entityKind: "worktree",
      entityId: "worktree-02",
    };

    const restored = new PaneLayoutStore();
    const report = restored.restore(snapshot);

    expect(report.restoredPaneCount).toBe(4);
    expect(restored.snapshot().panes.map((pane) => pane.paneId)).not.toContain("pane-94");
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual([
      "pane-kind-unknown",
      "pane-kind-unknown",
      "pane-entity-invalid",
      "pane-kind-duplicate",
    ]);
  });

  it("refuses a record that is not a layout record at all", () => {
    const report = new PaneLayoutStore().restore(["not", "a", "record"]);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual([
      "snapshot-shape-invalid",
    ]);
  });
});
