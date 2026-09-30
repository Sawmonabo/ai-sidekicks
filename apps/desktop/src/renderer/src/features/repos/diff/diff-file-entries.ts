// The rows of the changed-file list under one filter, as a pure model so the window, the
// keyboard and the selection address one index space. Row zero is the "All files" reset
// control. The filter is a substring match over the wire-verbatim path, not a fuzzy match:
// a subsequence match over a short list of exact paths surfaces paths that merely look wrong.

import {
  diffFileChangeCounts,
  diffFileChangeNotes,
  type DiffModel,
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
   * How many changed files matched; zero draws the no-match line. Carried so callers need
   * not subtract row zero from `entries.length`.
   */
  readonly matchCount: number;
}

/**
 * Where the current narrowing sits in the drawn rows, or that the filter hides it. A hidden
 * narrowing has no row; answering row zero would mark "All files" current while the renderer
 * still shows the file, and `-1` would pass as an index, so the state is a union member.
 */
export type SelectedEntryRow =
  /** Row zero for the whole change set, or the row a selected path is drawn on. */
  | { readonly kind: "row"; readonly index: number }
  /** A file is narrowed to and this filter draws no row for it. */
  | { readonly kind: "hidden-by-filter" };

/** Read the rows a change set and a filter produce, in the order they are drawn. */
export function diffFileListReading(diff: DiffModel, filterText: string): DiffFileListReading {
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
