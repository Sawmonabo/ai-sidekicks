// The five deck acts, driven against a real layout — what each one moves, and what
// each one says.
//
// The announcements are the half that goes stale unwatched: the deck's focus is a
// ring rather than DOM focus, so a screen reader follows nothing unless an act says
// what happened. Every case below asserts the sentence as well as the move.

import { describe, expect, it, vi } from "vitest";

import { DECK_RESTORED_PANE_CAP } from "../../../core/index.js";
import type { Announce } from "../../../primitives/index.js";
import { DeckLayout } from "../model/deck-layout.js";
import { NO_FOCUSED_PANE_SENTENCE, deckActsOn, detachedPaneCloseRefusal } from "./deck-acts.js";

/** A layout holding a timeline, a runs list, and an approvals pane, in that order. */
function threePaneLayout(): DeckLayout {
  const layout = new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
  layout.open({ kind: "timeline", entity: undefined });
  layout.open({ kind: "runs", entity: undefined });
  layout.open({ kind: "approvals", entity: undefined });
  return layout;
}

/**
 * No pane is in a window of its own — the reading every case but the two below takes.
 *
 * Declared once rather than inlined, so the cases that are not ABOUT detachment say so
 * by naming this and a reader can see at a glance which two are.
 */
const NOTHING_IS_DETACHED = (): boolean => false;

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
    const acts = deckActsOn(layout, announce, NOTHING_IS_DETACHED);
    const [first, second] = layout.snapshot().panes;
    layout.focus(first?.paneId ?? "");

    acts.focusNextPane();

    expect(layout.snapshot().focusedPaneId).toBe(second?.paneId);
    expect(announce.said).toStrictEqual([["Focused the runs pane, position 2 of 3.", "polite"]]);
  });

  it("wraps backwards from the first pane to the last", () => {
    const layout = threePaneLayout();
    const announce = announcer();
    const acts = deckActsOn(layout, announce, NOTHING_IS_DETACHED);
    const panes = layout.snapshot().panes;
    layout.focus(panes[0]?.paneId ?? "");

    acts.focusPreviousPane();

    expect(layout.snapshot().focusedPaneId).toBe(panes[2]?.paneId);
    expect(announce.said[0]?.[0]).toBe("Focused the approvals pane, position 3 of 3.");
  });

  it("says a one-pane deck has nowhere to cycle rather than moving in silence", () => {
    const layout = new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
    layout.open({ kind: "timeline", entity: undefined });
    const announce = announcer();

    deckActsOn(layout, announce, NOTHING_IS_DETACHED).focusNextPane();

    expect(announce.said).toStrictEqual([
      ["The timeline pane is the only pane open.", "assertive"],
    ]);
  });

  it("negative control: an empty deck says nothing, because the deck already does", () => {
    // Without this the case above would pass over an act that announced on every
    // press, including over a deck that renders its own "No panes are open."
    const announce = announcer();
    deckActsOn(
      new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP }),
      announce,
      NOTHING_IS_DETACHED,
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

    deckActsOn(layout, announce, NOTHING_IS_DETACHED).closeFocusedPane();

    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "timeline",
      "approvals",
    ]);
    expect(announce.said).toStrictEqual([["Closed the runs pane.", "polite"]]);
  });

  it("says there is no focused pane rather than closing nothing quietly", () => {
    const layout = new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
    const announce = announcer();

    deckActsOn(layout, announce, NOTHING_IS_DETACHED).closeFocusedPane();

    expect(announce.said).toStrictEqual([[NO_FOCUSED_PANE_SENTENCE, "assertive"]]);
  });

  it("refuses a pane that is in a window of its own, and names the way back", () => {
    // The stranding case: `layout.close` removes the slot the auxiliary window returns
    // INTO, so the shell goes on holding a window whose placeholder is gone and its
    // return signal names a pane the deck no longer has. The act refuses instead, and
    // the sentence names the control the placeholder already offers.
    const layout = threePaneLayout();
    const announce = announcer();
    const detached = layout.snapshot().panes[1];
    layout.focus(detached?.paneId ?? "");

    deckActsOn(layout, announce, (paneId) => paneId === detached?.paneId).closeFocusedPane();

    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "timeline",
      "runs",
      "approvals",
    ]);
    expect(announce.said).toStrictEqual([[detachedPaneCloseRefusal("runs"), "assertive"]]);
  });

  it("negative control: a detached pane that is not the focused one closes as usual", () => {
    // Without this the case above would pass over a guard that refused every close the
    // moment ANY pane was in a window of its own, which is a deck nobody can tidy.
    const layout = threePaneLayout();
    const announce = announcer();
    const [first, second] = layout.snapshot().panes;
    layout.focus(second?.paneId ?? "");

    deckActsOn(layout, announce, (paneId) => paneId === first?.paneId).closeFocusedPane();

    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "timeline",
      "approvals",
    ]);
    expect(announce.said).toStrictEqual([["Closed the runs pane.", "polite"]]);
  });
});

describe("moving the focused pane", () => {
  it("moves it and reuses the drag path's own sentence", () => {
    const layout = threePaneLayout();
    const announce = announcer();
    const [first] = layout.snapshot().panes;
    layout.focus(first?.paneId ?? "");

    deckActsOn(layout, announce, NOTHING_IS_DETACHED).moveFocusedPaneRight();

    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "runs",
      "timeline",
      "approvals",
    ]);
    expect(announce.said).toStrictEqual([
      ["Moved the timeline pane to position 2 of 3.", "polite"],
    ]);
  });

  it("says a pane at the end was not moved, in the assertive lane", () => {
    const layout = threePaneLayout();
    const announce = announcer();
    const [first] = layout.snapshot().panes;
    layout.focus(first?.paneId ?? "");

    deckActsOn(layout, announce, NOTHING_IS_DETACHED).moveFocusedPaneLeft();

    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "timeline",
      "runs",
      "approvals",
    ]);
    expect(announce.said).toStrictEqual([["The timeline pane was not moved.", "assertive"]]);
  });

  it("says there is no focused pane rather than moving nothing quietly", () => {
    const layout = new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
    const announce = announcer();

    deckActsOn(layout, announce, NOTHING_IS_DETACHED).moveFocusedPaneLeft();

    expect(announce.said).toStrictEqual([[NO_FOCUSED_PANE_SENTENCE, "assertive"]]);
  });
});
