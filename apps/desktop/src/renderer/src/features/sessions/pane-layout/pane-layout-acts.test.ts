// The five deck acts, driven against a real layout — what each one moves, and what
// each one says.
//
// The announcements are the half that goes stale unwatched: the deck's focus is a
// ring rather than DOM focus, so a screen reader follows nothing unless an act says
// what happened. Every case below asserts the sentence as well as the move.

import { describe, expect, it, vi } from "vitest";

import { PANE_LAYOUT_RESTORED_PANE_CAP } from "./pane-layout-store.js";
import type { Announce } from "@renderer/console/primitives/index.js";
import { PaneLayoutStore } from "./pane-layout-store.js";
import { NO_FOCUSED_PANE_SENTENCE, paneLayoutActsOn } from "./pane-layout-acts.js";

/** A layout holding a transcript, a runs list, and an approvals pane, in that order. */
function threePaneLayout(): PaneLayoutStore {
  const layout = new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
  layout.open({ kind: "transcript" });
  layout.open({ kind: "runs" });
  layout.open({ kind: "approvals" });
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
  it("cycles the deck and says which pane, and where it sits", () => {
    const layout = threePaneLayout();
    const announce = announcer();
    const acts = paneLayoutActsOn(layout, announce);
    const [first, second] = layout.snapshot().panes;
    layout.focus(first?.paneId ?? "");

    acts.focusNextPane();

    expect(layout.snapshot().focusedPaneId).toBe(second?.paneId);
    expect(announce.said).toStrictEqual([["Focused the runs pane, position 2 of 3.", "polite"]]);
  });

  it("wraps backwards from the first pane to the last", () => {
    const layout = threePaneLayout();
    const announce = announcer();
    const acts = paneLayoutActsOn(layout, announce);
    const panes = layout.snapshot().panes;
    layout.focus(panes[0]?.paneId ?? "");

    acts.focusPreviousPane();

    expect(layout.snapshot().focusedPaneId).toBe(panes[2]?.paneId);
    expect(announce.said[0]?.[0]).toBe("Focused the approvals pane, position 3 of 3.");
  });

  it("says a one-pane deck has nowhere to cycle rather than moving in silence", () => {
    const layout = new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
    layout.open({ kind: "transcript" });
    const announce = announcer();

    paneLayoutActsOn(layout, announce).focusNextPane();

    expect(announce.said).toStrictEqual([
      ["The transcript pane is the only pane open.", "assertive"],
    ]);
  });

  it("negative control: an empty deck says nothing, because the deck already does", () => {
    // Without this the case above would pass over an act that announced on every
    // press, including over a deck that renders its own "No panes are open."
    const announce = announcer();
    paneLayoutActsOn(
      new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP }),
      announce,
    ).focusNextPane();
    expect(announce.said).toStrictEqual([]);
  });
});

describe("closing the focused pane", () => {
  it("closes it and names what closed", () => {
    const layout = threePaneLayout();
    const announce = announcer();
    const second = layout.snapshot().panes[1];
    layout.focus(second?.paneId ?? "");

    paneLayoutActsOn(layout, announce).closeFocusedPane();

    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "transcript",
      "approvals",
    ]);
    expect(announce.said).toStrictEqual([["Closed the runs pane.", "polite"]]);
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
      "runs",
      "transcript",
      "approvals",
    ]);
    expect(announce.said).toStrictEqual([
      ["Moved the transcript pane to position 2 of 3.", "polite"],
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
      "runs",
      "approvals",
    ]);
    expect(announce.said).toStrictEqual([["The transcript pane was not moved.", "assertive"]]);
  });

  it("says there is no focused pane rather than moving nothing quietly", () => {
    const layout = new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
    const announce = announcer();

    paneLayoutActsOn(layout, announce).moveFocusedPaneLeft();

    expect(announce.said).toStrictEqual([[NO_FOCUSED_PANE_SENTENCE, "assertive"]]);
  });
});
