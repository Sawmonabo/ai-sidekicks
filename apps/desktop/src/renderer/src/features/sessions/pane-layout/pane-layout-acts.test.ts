// The five pane layout acts against a real layout: what each moves and what each says.
// Focus is a ring rather than DOM focus, so every case asserts the announced sentence too.

import { describe, expect, it, vi } from "vitest";

import { PANE_LAYOUT_RESTORED_PANE_CAP } from "./pane-layout-store.js";
import type { Announce } from "#renderer/components/LiveAnnouncer/live-announcer.js";
import { PaneLayoutStore } from "./pane-layout-store.js";
import { NO_FOCUSED_PANE_SENTENCE, paneLayoutActsOn } from "./pane-layout-acts.js";

/** A layout holding a transcript, a terminal, and an agents pane, in that order. */
function threePaneLayout(): PaneLayoutStore {
  const layout = new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
  layout.open({ kind: "transcript" });
  layout.open({ kind: "terminal" });
  layout.open({ kind: "agents" });
  return layout;
}

function announcer(): Announce & { readonly said: string[][] } {
  const said: string[][] = [];
  const announce = vi.fn<Announce>((message: string, politeness?: string) => {
    said.push([message, politeness ?? "polite"]);
  });
  return Object.assign(announce as unknown as Announce, { said });
}

describe("focusing the next and previous pane", () => {
  it("cycles the pane layout and says which pane, and where it sits", () => {
    const layout = threePaneLayout();
    const announce = announcer();
    const acts = paneLayoutActsOn(layout, announce);
    const [first, second] = layout.snapshot().panes;
    layout.focus(first?.paneId ?? "");

    acts.focusNextPane();

    expect(layout.snapshot().focusedPaneId).toBe(second?.paneId);
    expect(announce.said).toStrictEqual([
      ["Focused the Terminal pane, position 2 of 3.", "polite"],
    ]);
  });
});

describe("closing the focused pane", () => {
  it("closes it and names what closed", () => {
    const layout = threePaneLayout();
    const announce = announcer();
    // The agents pane's kind id and on-screen title differ, so the sentence must use the title.
    const third = layout.snapshot().panes[2];
    layout.focus(third?.paneId ?? "");

    paneLayoutActsOn(layout, announce).closeFocusedPane();

    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "transcript",
      "terminal",
    ]);
    expect(announce.said).toStrictEqual([["Closed the Sidekicks pane.", "polite"]]);
  });

  it("says there is no focused pane rather than closing nothing quietly", () => {
    const layout = new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
    const announce = announcer();

    paneLayoutActsOn(layout, announce).closeFocusedPane();

    expect(announce.said).toStrictEqual([[NO_FOCUSED_PANE_SENTENCE, "assertive"]]);
  });
});

describe("moving the focused pane", () => {
  it("moves it and reuses the drag path's own sentence", () => {
    const layout = threePaneLayout();
    const announce = announcer();
    const [first] = layout.snapshot().panes;
    layout.focus(first?.paneId ?? "");

    paneLayoutActsOn(layout, announce).moveFocusedPaneRight();

    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "terminal",
      "transcript",
      "agents",
    ]);
    expect(announce.said).toStrictEqual([
      ["Moved the Transcript pane to position 2 of 3.", "polite"],
    ]);
  });

  it("says a pane at the end was not moved, in the assertive lane", () => {
    const layout = threePaneLayout();
    const announce = announcer();
    const [first] = layout.snapshot().panes;
    layout.focus(first?.paneId ?? "");

    paneLayoutActsOn(layout, announce).moveFocusedPaneLeft();

    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "transcript",
      "terminal",
      "agents",
    ]);
    expect(announce.said).toStrictEqual([["The Transcript pane was not moved.", "assertive"]]);
  });

  it("says there is no focused pane rather than moving nothing quietly", () => {
    const layout = new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
    const announce = announcer();

    paneLayoutActsOn(layout, announce).moveFocusedPaneLeft();

    expect(announce.said).toStrictEqual([[NO_FOCUSED_PANE_SENTENCE, "assertive"]]);
  });
});
