// The pane layout acts against a real layout: what each moves and what each says. Focus is a
// ring rather than DOM focus, so every case asserts the announced sentence too.

import { describe, expect, it, vi } from "vitest";

import type { Announce } from "#renderer/components/LiveAnnouncer/announcer.js";
import { PaneLayoutStore } from "./store.js";
import { NO_FOCUSED_PANE_SENTENCE, paneLayoutActsOn } from "./acts.js";

const WORKTREE = { kind: "worktree", id: "worktree-01" } as const;

/** Review and Sidekicks along the row, in that order, and the terminal below it. */
function reviewSidekicksTerminal(): PaneLayoutStore {
  const layout = new PaneLayoutStore();
  layout.open({ kind: "diff", entity: WORKTREE });
  layout.open({ kind: "agents" });
  layout.open({ kind: "terminal" });
  return layout;
}

function announcer(): Announce & { readonly said: string[][] } {
  const said: string[][] = [];
  const announce = vi.fn<Announce>((message: string, politeness?: string) => {
    said.push([message, politeness ?? "polite"]);
  });
  return Object.assign(announce as unknown as Announce, { said });
}

function focusKind(layout: PaneLayoutStore, kind: string): void {
  layout.focus(layout.snapshot().panes.find((pane) => pane.kind === kind)?.paneId ?? "");
}

describe("focusing and closing panes", () => {
  it("cycles focus and says which pane and where it sits", () => {
    const layout = reviewSidekicksTerminal();
    const announce = announcer();
    focusKind(layout, "diff");

    paneLayoutActsOn(layout, announce).focusNextPane();

    expect(announce.said).toStrictEqual([
      ["Focused the Sidekicks pane, position 2 of 3.", "polite"],
    ]);
  });

  it("closes the focused pane by its on-screen title, and refuses with none focused", () => {
    const layout = reviewSidekicksTerminal();
    const announce = announcer();
    // The agents kind's id and its title differ, so the sentence must use the title.
    focusKind(layout, "agents");

    paneLayoutActsOn(layout, announce).closeFocusedPane();
    paneLayoutActsOn(new PaneLayoutStore(), announce).closeFocusedPane();

    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual(["diff", "terminal"]);
    expect(announce.said).toStrictEqual([
      ["Closed the Sidekicks pane.", "polite"],
      [NO_FOCUSED_PANE_SENTENCE, "assertive"],
    ]);
  });
});

describe("moving the focused pane", () => {
  it("says where a move landed, a cross of the conversation, and a move into the edge", () => {
    const layout = reviewSidekicksTerminal();
    const announce = announcer();
    const acts = paneLayoutActsOn(layout, announce);
    focusKind(layout, "diff");

    acts.moveFocusedPaneRight();
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "agents",
      "diff",
      "terminal",
    ]);
    // Now at the window's edge of a block right of the conversation.
    acts.moveFocusedPaneRight();
    focusKind(layout, "agents");
    // At the row's end facing the conversation: the block crosses it, the order kept.
    acts.moveFocusedPaneLeft();
    expect(layout.snapshot().side).toBe("left");

    expect(announce.said).toStrictEqual([
      ["Moved the Review pane to position 2 of 2.", "polite"],
      ["The Review pane was not moved.", "assertive"],
      ["Moved the Sidekicks pane to position 1 of 2.", "polite"],
    ]);
  });

  it("puts the terminal above and below the row, and says when it cannot move", () => {
    const layout = reviewSidekicksTerminal();
    const announce = announcer();
    const acts = paneLayoutActsOn(layout, announce);

    acts.moveTerminalUp();
    expect(layout.snapshot().terminalPlace).toBe("above");
    acts.moveTerminalUp();
    acts.moveTerminalDown();
    paneLayoutActsOn(new PaneLayoutStore(), announce).moveTerminalUp();

    expect(announce.said).toStrictEqual([
      ["Moved the Terminal pane to position 1 of 2.", "polite"],
      ["The Terminal pane was not moved.", "assertive"],
      ["Moved the Terminal pane to position 2 of 2.", "polite"],
      ["The Terminal pane was not moved.", "assertive"],
    ]);
  });

  it("says there is no focused pane rather than moving nothing quietly", () => {
    const announce = announcer();
    paneLayoutActsOn(new PaneLayoutStore(), announce).moveFocusedPaneLeft();
    expect(announce.said).toStrictEqual([[NO_FOCUSED_PANE_SENTENCE, "assertive"]]);
  });
});
