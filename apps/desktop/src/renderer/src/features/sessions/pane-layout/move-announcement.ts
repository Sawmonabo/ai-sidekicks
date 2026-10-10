// What a pane's move says out loud, the same for the keyboard and the pointer: the place it
// landed, or that it stayed put.

import { type AnnouncementPoliteness } from "#renderer/components/LiveAnnouncer/announcer.js";
import { TITLE_BY_PANE_KIND } from "#renderer/components/PaneFrame/PaneFrame.js";
import { rowPanes, type PaneLayoutState } from "./state.js";

/** What a move is announced as, and in which lane. */
export interface PaneMoveAnnouncement {
  readonly message: string;
  readonly politeness: AnnouncementPoliteness;
}

/**
 * What moving `paneId` from the `before` arrangement to the `after` one is announced as. A main
 * pane's place is its one-based position along the row, and the terminal's is first above the
 * row and second below it. A move is polite; one that changed nothing is assertive, because that
 * lane is for "the thing you tried did not happen". Throws for a pane `before` does not hold.
 */
export function paneMoveAnnouncement(
  before: PaneLayoutState,
  after: PaneLayoutState,
  paneId: string,
): PaneMoveAnnouncement {
  const pane = before.panes.find((candidate) => candidate.paneId === paneId);
  if (pane === undefined) {
    throw new Error(`A pane that is not in the layout was moved: ${paneId}`);
  }
  const title = TITLE_BY_PANE_KIND[pane.kind];
  const placeBefore = placeOf(before, paneId);
  const placeAfter = placeOf(after, paneId);
  if (placeBefore.position === placeAfter.position && before.side === after.side) {
    return { message: `The ${title} pane was not moved.`, politeness: "assertive" };
  }
  return {
    message:
      `Moved the ${title} pane to position ` +
      `${String(placeAfter.position)} of ${String(placeAfter.count)}.`,
    politeness: "polite",
  };
}

/** A pane's one-based place and how many places there are. */
function placeOf(
  state: PaneLayoutState,
  paneId: string,
): { readonly position: number; readonly count: number } {
  const row = rowPanes(state.panes);
  const rowPosition = row.findIndex((pane) => pane.paneId === paneId);
  if (rowPosition >= 0) {
    return { position: rowPosition + 1, count: row.length };
  }
  return { position: state.terminalPlace === "above" ? 1 : 2, count: 2 };
}
