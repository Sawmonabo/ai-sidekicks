// The block as it moves: where an open lands, what a close leaves and focuses, and how a pane
// and the terminal move along and against the row. Snapshots are in `store.snapshot.test.ts`.

import { describe, expect, it } from "vitest";

import { PaneLayoutStore } from "./store.js";
import { rowPanes } from "./state.js";

const WORKTREE = { kind: "worktree", id: "worktree-01" } as const;

function rowKinds(layout: PaneLayoutStore): readonly string[] {
  return rowPanes(layout.snapshot().panes).map((pane) => pane.kind);
}

/** Review, Preview and the inspector, each opened beside the one focused before it. */
function threePaneLayout(): PaneLayoutStore {
  const layout = new PaneLayoutStore();
  layout.open({ kind: "diff", entity: WORKTREE });
  layout.open({ kind: "browser" });
  layout.open({ kind: "inspector", entity: WORKTREE });
  return layout;
}

describe("opening panes", () => {
  it("keeps every pane open, each landing beside the focused one, and focuses a repeat", () => {
    const layout = threePaneLayout();
    expect(rowKinds(layout)).toStrictEqual(["diff", "browser", "inspector"]);

    // Beside the focused pane, not at the row's end.
    const review = layout.snapshot().panes[0]?.paneId ?? "";
    layout.focus(review);
    layout.open({ kind: "agents" });
    expect(rowKinds(layout)).toStrictEqual(["diff", "agents", "browser", "inspector"]);

    // One pane per kind: a second Review over another checkout re-points the one open.
    const reopened = layout.open({ kind: "diff", entity: { kind: "worktree", id: "worktree-02" } });
    expect(reopened).toBe(review);
    expect(layout.snapshot().panes).toHaveLength(4);
    expect(layout.snapshot().panes[0]?.entity).toStrictEqual({
      kind: "worktree",
      id: "worktree-02",
    });
    expect(layout.snapshot().focusedPaneId).toBe(review);
  });

  it("gives up the full width when a pane opens or closes", () => {
    const layout = threePaneLayout();
    const [review, preview] = layout.snapshot().panes;
    layout.setFullWidth(review?.paneId);
    layout.open({ kind: "agents" });
    expect(layout.snapshot().fullWidthPaneId).toBeUndefined();

    layout.setFullWidth(review?.paneId);
    layout.close(preview?.paneId ?? "");
    expect(layout.snapshot().fullWidthPaneId).toBeUndefined();
  });
});

describe("closing panes", () => {
  it("leaves a pane opened from the closed one open, and gives focus back", () => {
    const layout = new PaneLayoutStore();
    const review = layout.open({ kind: "diff", entity: WORKTREE });
    const preview = layout.open({ kind: "browser" }, { linkedSourcePaneId: review });
    const inspector = layout.open({ kind: "inspector", entity: WORKTREE });

    // The inspector opened from Preview's focus, so closing it focuses Preview again.
    layout.close(inspector);
    expect(layout.snapshot().focusedPaneId).toBe(preview);

    // Preview was opened from Review; closing Review leaves it where it stood.
    layout.close(review);
    expect(rowKinds(layout)).toStrictEqual(["browser"]);
  });
});

describe("moving a pane along the row", () => {
  it("moves one place, crosses the conversation at its end, and stops at the window's edge", () => {
    const layout = threePaneLayout();
    const [review, , inspector] = layout.snapshot().panes;

    layout.movePane(inspector?.paneId ?? "", -1);
    expect(rowKinds(layout)).toStrictEqual(["diff", "inspector", "browser"]);

    // Right of the conversation, the row's first pane faces it: a move left crosses it whole.
    layout.movePane(review?.paneId ?? "", -1);
    expect(layout.snapshot().side).toBe("left");
    expect(rowKinds(layout)).toStrictEqual(["diff", "inspector", "browser"]);

    // Left of it, that pane sits at the window's edge, where a move left changes nothing.
    let changes = 0;
    layout.subscribe(() => {
      changes += 1;
    });
    layout.movePane(review?.paneId ?? "", -1);
    expect(changes).toBe(0);

    // The last pane now faces the conversation: a move right brings the block back.
    layout.movePane(layout.snapshot().panes[2]?.paneId ?? "", 1);
    expect(layout.snapshot().side).toBe("right");
  });

  it("lands a pane dragged past the conversation at the row's far end on the other side", () => {
    const layout = threePaneLayout();
    const [, preview] = layout.snapshot().panes;
    layout.moveBlockAcross(preview?.paneId ?? "");
    expect(layout.snapshot().side).toBe("left");
    expect(rowKinds(layout)).toStrictEqual(["browser", "diff", "inspector"]);
  });

  it("puts the terminal above or below the row, and nowhere with no row beside it", () => {
    const layout = new PaneLayoutStore();
    layout.open({ kind: "terminal" });
    layout.placeTerminal("above");
    expect(layout.snapshot().terminalPlace).toBe("below");

    layout.open({ kind: "diff", entity: WORKTREE });
    layout.placeTerminal("above");
    expect(layout.snapshot().terminalPlace).toBe("above");
    // The terminal stays out of the row's order wherever it sits.
    expect(rowKinds(layout)).toStrictEqual(["diff"]);
  });
});
