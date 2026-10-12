// The pane layout acts a person can perform without a pointer, and what each announces.
//
// The layout's own key handler (`SessionPaneLayout.tsx`), the window's chords and the palette
// (through `mounted.ts`) dispatch the same acts.
//
// Focusing a pane moves DOM focus into it, and the layout follows the focus that lands; each act
// also says its result in a live region. The move acts say what the pointer's drop says
// (`move-announcement.ts`). A move that goes nowhere is not a refusal; only an act with no subject
// is refused: no layout mounted, no pane focused, or no workspace for the inspector to open on.

import { TITLE_BY_PANE_KIND } from "#renderer/components/PaneFrame/PaneFrame.js";
import type { Announce } from "#renderer/components/LiveAnnouncer/announcer.js";
import { type DaemonReply } from "#renderer/services/daemon/reply.js";
import { type InspectedCheckout } from "../services/session-workspace.js";
import type { PaneLayoutStore } from "./store.js";
import { paneMoveAnnouncement } from "./move-announcement.js";
import { adjacentPane, terminalPane, type TerminalPlace } from "./state.js";

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
  readonly moveTerminalUp: () => void;
  readonly moveTerminalDown: () => void;
  /** Opens the inspector on the session's workspace beside the focused pane. */
  readonly openInspector: () => void;
}

/** What the acts reach beyond the layout: the view's focus and the session's workspace. */
export interface PaneLayoutActReach {
  /** Moves DOM focus into a pane and brings it into view; the layout follows the focus. */
  readonly focusPane: (paneId: string) => void;
  /** Reads the checkout the inspector opens on; `undefined` when the session has none. */
  readonly readInspectedCheckout: () => Promise<DaemonReply<InspectedCheckout | undefined>>;
}

/** One act, by name. */
export type PaneLayoutActName = keyof PaneLayoutActs;

/** What an act says when the pane layout it reached is focusing nothing. */
export const NO_FOCUSED_PANE_SENTENCE = "No pane is focused.";

/** What the inspector's act says when the session is bound to no workspace. */
export const NO_INSPECTED_CHECKOUT_SENTENCE = "This session has no workspace to inspect.";

/**
 * Binds the acts to one pane layout, an announcer and what they reach beyond the layout.
 *
 * Kept out of `PaneLayoutStore`, which holds no opinion about live regions or the document.
 */
export function paneLayoutActsOn(
  layout: PaneLayoutStore,
  announce: Announce,
  reach: PaneLayoutActReach,
): PaneLayoutActs {
  const focusStep = (step: 1 | -1): void => {
    const { panes, focusedPaneId } = layout.snapshot();
    const focused = adjacentPane(panes, focusedPaneId, step);
    if (focused === undefined) {
      // An empty block draws nothing to focus, so there is nothing to say.
      return;
    }
    reach.focusPane(focused.paneId);
    const position = panes.indexOf(focused);
    if (focused.paneId === focusedPaneId) {
      // One pane: cycling lands where it started. Assertive, like a move that did not happen.
      announce(`The ${TITLE_BY_PANE_KIND[focused.kind]} pane is the only pane open.`, "assertive");
      return;
    }
    announce(
      `Focused the ${TITLE_BY_PANE_KIND[focused.kind]} pane, position ` +
        `${String(position + 1)} of ${String(panes.length)}.`,
      "polite",
    );
  };

  const moveStep = (step: 1 | -1): void => {
    const before = layout.snapshot();
    const moved = before.panes.find((pane) => pane.paneId === before.focusedPaneId);
    if (moved === undefined) {
      announce(NO_FOCUSED_PANE_SENTENCE, "assertive");
      return;
    }
    layout.movePane(moved.paneId, step);
    const announcement = paneMoveAnnouncement(before, layout.snapshot(), moved.paneId);
    announce(announcement.message, announcement.politeness);
  };

  const placeTerminal = (place: TerminalPlace): void => {
    const before = layout.snapshot();
    const terminal = terminalPane(before.panes);
    if (terminal === undefined) {
      announce(`The ${TITLE_BY_PANE_KIND.terminal} pane was not moved.`, "assertive");
      return;
    }
    layout.placeTerminal(place);
    const announcement = paneMoveAnnouncement(before, layout.snapshot(), terminal.paneId);
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
    moveTerminalUp: () => {
      placeTerminal("above");
    },
    moveTerminalDown: () => {
      placeTerminal("below");
    },
    openInspector: () => {
      void reach.readInspectedCheckout().then((read) => {
        if (read.status === "refused") {
          announce(read.refusal.detail, "assertive");
          return;
        }
        if (read.value === undefined) {
          announce(NO_INSPECTED_CHECKOUT_SENTENCE, "assertive");
          return;
        }
        // Opened beside the focused pane, which takes the focus back when the inspector closes.
        layout.open({ kind: "inspector", entity: read.value });
      });
    },
  };
}
