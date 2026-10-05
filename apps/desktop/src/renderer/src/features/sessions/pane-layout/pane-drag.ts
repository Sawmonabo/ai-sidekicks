// Moving a pane by dragging its header: what a drop commits and what it says out loud.
//
// The gesture is the shared pointer reorder (`lib/reorder-drag.ts`), which glides the pane into
// its place and hands over where it landed; this module commits that through
// `PaneLayoutStore.reorderPane` and announces it, in the same words as the keyboard move.

import {
  type Announce,
  type AnnouncementPoliteness,
} from "#renderer/components/LiveAnnouncer/live-announcer.js";
import { TITLE_BY_PANE_KIND } from "#renderer/components/PaneFrame/PaneFrame.js";
import { type PaneKind } from "#renderer/routing/panes/pane-kinds.js";
import type { PaneLayoutStore } from "./pane-layout-store.js";

/** What a settled drop is announced as, and in which lane. */
export interface PaneDropAnnouncement {
  readonly message: string;
  readonly politeness: AnnouncementPoliteness;
}

/**
 * What a settled drop is announced as.
 *
 * A move is polite; a drop that changed nothing is assertive, because that lane is for "the
 * thing you tried did not happen". The position is one-based and given against the pane count.
 */
export function paneDropAnnouncement(
  paneKind: PaneKind,
  fromPosition: number,
  toPosition: number,
  paneCount: number,
): PaneDropAnnouncement {
  if (fromPosition === toPosition) {
    return {
      message: `The ${TITLE_BY_PANE_KIND[paneKind]} pane was not moved.`,
      politeness: "assertive",
    };
  }
  return {
    message:
      `Moved the ${TITLE_BY_PANE_KIND[paneKind]} pane to position ` +
      `${String(toPosition + 1)} of ${String(paneCount)}.`,
    politeness: "polite",
  };
}

/**
 * Settles one drop: moves `paneId` to `toPosition` and announces what happened. Whether the pane
 * moved is measured from its index before and after, since the store clamps the position. Throws
 * for a pane the layout does not hold.
 */
export function commitPaneDrop(
  layout: PaneLayoutStore,
  paneId: string,
  toPosition: number,
  announce: Announce,
): void {
  const before = layout.snapshot().panes;
  const fromPosition = before.findIndex((pane) => pane.paneId === paneId);
  const draggedPane = before[fromPosition];
  if (draggedPane === undefined) {
    // A drag ends without committing when the layout changes under it, so this is a defect.
    throw new Error(`A pane that is not in the layout was dropped: ${paneId}`);
  }
  layout.reorderPane(paneId, toPosition);
  const after = layout.snapshot().panes;
  const announcement = paneDropAnnouncement(
    draggedPane.kind,
    fromPosition,
    after.findIndex((pane) => pane.paneId === paneId),
    after.length,
  );
  announce(announcement.message, announcement.politeness);
}
