// Moving a pane by dragging its header: what a drop commits and what it says out loud.
//
// The gesture is the shared pointer reorder (`lib/reorder-drag.ts`), which glides the pane into
// its place and hands over where it landed; this module commits that through the store and
// announces it, in the same words as the keyboard move.

import { type Announce } from "#renderer/components/LiveAnnouncer/announcer.js";
import type { PaneLayoutStore } from "./store.js";
import { paneMoveAnnouncement } from "./move-announcement.js";
import type { TerminalPlace } from "./state.js";

/** Where a dragged pane was let go: a place along its own list, past the conversation, or home. */
export type PaneDrop =
  | { readonly kind: "row"; readonly toPosition: number }
  | { readonly kind: "across-conversation" }
  | { readonly kind: "terminal"; readonly place: TerminalPlace }
  | { readonly kind: "in-place" };

/**
 * Settles one drop: commits it through the store and announces what happened, measured from the
 * arrangement before and after, since the store clamps a position. Throws for a pane the layout
 * does not hold: a drag ends without committing when the layout changes under it.
 */
export function commitPaneDrop(
  layout: PaneLayoutStore,
  paneId: string,
  drop: PaneDrop,
  announce: Announce,
): void {
  const before = layout.snapshot();
  switch (drop.kind) {
    case "row":
      layout.reorderPane(paneId, drop.toPosition);
      break;
    case "across-conversation":
      layout.moveBlockAcross(paneId);
      break;
    case "terminal":
      layout.placeTerminal(drop.place);
      break;
    case "in-place":
      break;
  }
  const announcement = paneMoveAnnouncement(before, layout.snapshot(), paneId);
  announce(announcement.message, announcement.politeness);
}
