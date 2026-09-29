// The five things a person can ask of the pane layout without a pointer, and what each of
// them says out loud.
//
// ONE IMPLEMENTATION, TWO CALLERS. The pane layout's own key handler (`SessionPaneLayout.tsx`) dispatches
// these when focus is inside the pane layout, and the palette dispatches the same five from
// anywhere in the session through `mounted-pane-layouts.ts` beside this file, so "move the
// pane" has one answer.
//
// EVERY ACT SAYS WHAT HAPPENED. The pane layout's focus is a ring rather than DOM focus, so
// a screen reader follows nothing when the focused pane changes: without a live-region
// line, cycling the pane layout is silent.
// The move act reuses `paneDropAnnouncement` — the drag path's own strings — rather
// than composing a second sentence for the same outcome, which is what keeps the
// keyboard path and the pointer path saying the same thing about the same move.
//
// A BOUNDARY IS NOT A REFUSAL. Moving the leftmost pane left changes nothing, and
// `paneDropAnnouncement` already carries that case in its assertive lane ("was not
// moved"). What IS refused is an act with no subject at all — no pane layout mounted, or a
// pane layout focusing nothing — and those two are said by `mounted-pane-layouts.ts` and
// by this file respectively, because only one of them is a fact about the pane layout.

import { TITLE_BY_PANE_KIND } from "@renderer/components/PaneFrame/PaneFrame.js";
import type { Announce } from "@renderer/components/LiveAnnouncer/live-announcer.js";
import type { PaneLayoutStore } from "./pane-layout-store.js";
import { paneDropAnnouncement } from "./pane-drag.js";

/**
 * The acts a mounted pane layout offers. One niladic call per act, so the name is the whole
 * request: the palette contributes these at composition time, long before a pane layout exists
 * to act on.
 */
export interface PaneLayoutActs {
  readonly focusNextPane: () => void;
  readonly focusPreviousPane: () => void;
  readonly closeFocusedPane: () => void;
  readonly moveFocusedPaneLeft: () => void;
  readonly moveFocusedPaneRight: () => void;
}

/** One act, by name. Derived from the interface, so the two cannot drift. */
export type PaneLayoutActName = keyof PaneLayoutActs;

/** What an act says when the pane layout it reached is focusing nothing. */
export const NO_FOCUSED_PANE_SENTENCE = "No pane is focused.";

/**
 * Bind the five acts to one pane layout.
 *
 * A function of the layout and the announcer rather than a method on `PaneLayoutStore`:
 * the store is what the pane layout IS and holds no opinion about live regions, and an
 * announcer reached from inside it would make every consumer of a layout a consumer
 * of the announcer too. The acts are the layer where a keystroke becomes a sentence.
 */
export function paneLayoutActsOn(layout: PaneLayoutStore, announce: Announce): PaneLayoutActs {
  const focusStep = (step: 1 | -1): void => {
    const before = layout.snapshot().focusedPaneId;
    layout.focusAdjacent(step);
    const { panes, focusedPaneId } = layout.snapshot();
    const position = panes.findIndex((pane) => pane.paneId === focusedPaneId);
    const focused = panes[position];
    if (focused === undefined) {
      // An empty pane layout. It already says so on screen — `SessionPaneLayout.tsx` renders the
      // nothing — so a second sentence would be the console repeating itself.
      return;
    }
    if (focusedPaneId === before) {
      // A pane layout of one pane, where cycling lands where it started. Said in the assertive
      // lane for `paneDropAnnouncement`'s reason: "the thing you tried did not
      // happen" is exactly what a cycle with nowhere to go is.
      announce(`The ${TITLE_BY_PANE_KIND[focused.kind]} pane is the only pane open.`, "assertive");
      return;
    }
    announce(
      `Focused the ${TITLE_BY_PANE_KIND[focused.kind]} pane, position ${String(position + 1)} of ${String(panes.length)}.`,
      "polite",
    );
  };

  const moveStep = (step: 1 | -1): void => {
    const before = layout.snapshot().panes;
    const fromPosition = before.findIndex(
      (pane) => pane.paneId === layout.snapshot().focusedPaneId,
    );
    const moved = before[fromPosition];
    if (moved === undefined) {
      announce(NO_FOCUSED_PANE_SENTENCE, "assertive");
      return;
    }
    layout.movePane(moved.paneId, step);
    const after = layout.snapshot().panes;
    const announcement = paneDropAnnouncement(
      moved.kind,
      fromPosition,
      after.findIndex((pane) => pane.paneId === moved.paneId),
      after.length,
    );
    announce(announcement.message, announcement.politeness);
  };

  return {
    focusNextPane: () => {
      focusStep(1);
    },
    focusPreviousPane: () => {
      focusStep(-1);
    },
    closeFocusedPane: () => {
      const { panes, focusedPaneId } = layout.snapshot();
      const closing = panes.find((pane) => pane.paneId === focusedPaneId);
      if (closing === undefined) {
        announce(NO_FOCUSED_PANE_SENTENCE, "assertive");
        return;
      }
      layout.close(closing.paneId);
      announce(`Closed the ${TITLE_BY_PANE_KIND[closing.kind]} pane.`, "polite");
    },
    moveFocusedPaneLeft: () => {
      moveStep(-1);
    },
    moveFocusedPaneRight: () => {
      moveStep(1);
    },
  };
}
