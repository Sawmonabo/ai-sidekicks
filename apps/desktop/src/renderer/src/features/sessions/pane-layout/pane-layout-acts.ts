// The five pane layout acts a person can perform without a pointer, and what each announces.
//
// The layout's own key handler (`SessionPaneLayout.tsx`) and the palette (through
// `mounted-pane-layouts.ts`) dispatch the same acts.
//
// Focus is a ring rather than DOM focus, so every act announces its result in a live region.
// The move act reuses `paneDropAnnouncement` so the keyboard and pointer paths say the same
// thing. A boundary move is not a refusal (`paneDropAnnouncement` covers "was not moved");
// only an act with no subject is refused: no layout mounted, or no pane focused.

import { TITLE_BY_PANE_KIND } from "@renderer/components/PaneFrame/PaneFrame.js";
import type { Announce } from "@renderer/components/LiveAnnouncer/live-announcer.js";
import type { PaneLayoutStore } from "./pane-layout-store.js";
import { paneDropAnnouncement } from "./pane-drag.js";

/**
 * The acts a mounted pane layout offers. One niladic call per act, so the name is the whole
 * request; the palette contributes them before any layout exists to act on.
 */
export interface PaneLayoutActs {
  readonly focusNextPane: () => void;
  readonly focusPreviousPane: () => void;
  readonly closeFocusedPane: () => void;
  readonly moveFocusedPaneLeft: () => void;
  readonly moveFocusedPaneRight: () => void;
}

/** One act, by name. */
export type PaneLayoutActName = keyof PaneLayoutActs;

/** What an act says when the pane layout it reached is focusing nothing. */
export const NO_FOCUSED_PANE_SENTENCE = "No pane is focused.";

/**
 * Binds the five acts to one pane layout and an announcer.
 *
 * Kept out of `PaneLayoutStore`, which holds no opinion about live regions.
 */
export function paneLayoutActsOn(layout: PaneLayoutStore, announce: Announce): PaneLayoutActs {
  const focusStep = (step: 1 | -1): void => {
    const before = layout.snapshot().focusedPaneId;
    layout.focusAdjacent(step);
    const { panes, focusedPaneId } = layout.snapshot();
    const position = panes.findIndex((pane) => pane.paneId === focusedPaneId);
    const focused = panes[position];
    if (focused === undefined) {
      // An empty layout already says so on screen; no second sentence.
      return;
    }
    if (focusedPaneId === before) {
      // One pane: cycling lands where it started. Assertive, like a move that did not happen.
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
