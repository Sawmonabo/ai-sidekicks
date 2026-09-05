// What a restore-path enumeration is handed, and how tall its window may grow.
//
// A MODULE OF ITS OWN because both arms take the same props — the list that draws
// every path and the windowed one past the threshold — and the bound belongs to the
// windowed arm's arithmetic. Declared in the list they would close a cycle with the
// arm it delegates to.

import { RESTORE_PATH_VISIBLE_ROW_CAP, RESTORE_PATH_ROW_HEIGHT_PX } from "../../core/index.js";

export interface RestorePathListProps {
  /** What the enumeration is called, for the scroll region's own name. */
  readonly label: string;
  readonly paths: readonly string[];
  /** Open one path in the diff pane. Absent where no diff exists for it. */
  readonly onOpenPath: ((path: string) => void) | undefined;
}

/** The tallest a windowed enumeration's scroll container may grow, in CSS pixels. */
export const RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX: number =
  RESTORE_PATH_VISIBLE_ROW_CAP * RESTORE_PATH_ROW_HEIGHT_PX;
