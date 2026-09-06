// What the changed-file list holds: the rows it draws, in order, under one filter.
//
// A PURE MODEL BESIDE THE COMPONENT, on this family's own seam — `diff-model.ts`
// beside the renderer, `hunk-row-layout.ts` beside the row index. The list is
// windowed, and a window is addressed by INDEX: which row a scroll position needs,
// which row an arrow key moves to, which row the selection is on. So the ordered
// sequence those indices address has to be a value something can hold and a test can
// walk, rather than an array built inside a render body and reachable only through
// the DOM it produced.
//
// THE RESET CONTROL IS ROW ZERO AND NOT A ROW BESIDE THE LIST. "All files" clears the
// narrowing, and folding it into the sequence is what makes one index space serve the
// window, the keyboard, and the selection at once: kept outside, every one of those
// three would need an off-by-one of its own, and the three would disagree the first
// time one of them was changed.
//
// THE FILTER IS A SUBSTRING MATCH OVER THE WIRE-VERBATIM PATH, and deliberately
// nothing cleverer. A fuzzy matcher exists in the console already
// (`palette/subsequence-score.ts`) and belongs to the palette's ranked-result
// problem; a file list is a dozen to a hundred exact strings a person is scanning
// rather than recalling, and a subsequence match over them surfaces paths whose
// letters merely appear in order, which reads as the filter being broken.

import {
  diffFileChangeCounts,
  diffFileChangeNotes,
  type ConsoleDiffModel,
  type DiffFileChangeCounts,
} from "./diff-model.js";

/** Row zero: the control that clears the narrowing, and what it counts. */
export interface AllFilesEntry {
  readonly kind: "all-files";
  /** Every file the change set holds, which the filter never narrows. */
  readonly fileCount: number;
}

/** One changed file's row. */
export interface ChangedFileEntry {
  readonly kind: "file";
  /** Wire-verbatim path, rendered as received and never re-rooted. */
  readonly path: string;
  readonly counts: DiffFileChangeCounts;
  /** What the patch's extended headers said, where they said anything. */
  readonly changeNotes: readonly string[];
}

/** One row of the changed-file list. Narrow on `kind`. */
export type DiffFileListEntry = AllFilesEntry | ChangedFileEntry;

/** The rows one filter leaves, and how many changed files are among them. */
export interface DiffFileListReading {
  readonly entries: readonly DiffFileListEntry[];
  /**
   * How many changed files matched. Zero draws the no-match line.
   *
   * Carried rather than derived from `entries.length` by the caller, because row zero
   * is always there and a caller subtracting one for it would be restating this
   * module's own shape at every call site.
   */
  readonly matchCount: number;
}

/** Read the rows a change set and a filter produce, in the order they are drawn. */
export function diffFileListReading(
  diff: ConsoleDiffModel,
  filterText: string,
): DiffFileListReading {
  const needle = filterText.trim().toLowerCase();
  const matching = diff.files.filter(
    (file) => needle === "" || file.path.toLowerCase().includes(needle),
  );
  return {
    entries: [
      { kind: "all-files", fileCount: diff.files.length },
      ...matching.map((file) => ({
        kind: "file" as const,
        path: file.path,
        counts: diffFileChangeCounts(file),
        changeNotes: diffFileChangeNotes(file),
      })),
    ],
    matchCount: matching.length,
  };
}

/**
 * Where the current narrowing sits in the drawn rows, or that this filter hides it.
 *
 * A CLOSED TWO-ARM ANSWER RATHER THAN AN INDEX WITH A FALLBACK. A narrowing the filter
 * hides has no row, and answering row zero for it made the list say the opposite of
 * what the pane was doing: "All files" took `aria-current` while the renderer went on
 * showing the one hidden file. The narrowing is the participant's own choice and the
 * filter is a way of looking at the list, so the choice STANDS and the list reports
 * that it has no row to point at — which is a state, not a value, and so is a member
 * of this union rather than a number outside the index space (`-1` is a number every
 * arithmetic in the caller would happily use).
 */
export type SelectedEntryRow =
  /** Row zero for the whole change set, or the row a selected path is drawn on. */
  | { readonly kind: "row"; readonly index: number }
  /** A file is narrowed to and this filter draws no row for it. */
  | { readonly kind: "hidden-by-filter" };

/** Read which row the current narrowing is on, or that the filter hides it. */
export function selectedEntryRow(
  entries: readonly DiffFileListEntry[],
  selectedFilePath: string | undefined,
): SelectedEntryRow {
  if (selectedFilePath === undefined) {
    return { kind: "row", index: 0 };
  }
  const found = entries.findIndex(
    (entry) => entry.kind === "file" && entry.path === selectedFilePath,
  );
  return found === -1 ? { kind: "hidden-by-filter" } : { kind: "row", index: found };
}

/** What the list says where the filter hides the file the renderer is showing. */
export const HIDDEN_SELECTION_COPY =
  "This filter hides the file the diff is showing, so no row here is current.";
