// The typed diff model both the pane and the inline card render, and the closed sets that
// make its illegal states unrepresentable. The word-level split of a line's text is derived
// per rendered row by `intraline-segment-cache.ts`, never at parse time, because computing
// every pair up front costs the whole change set before the virtualizer places a row.

/** The three things a line in a unified diff can be. Closed. */
export const DIFF_LINE_KINDS = ["context", "insert", "delete"] as const;

/** One line kind. Derived from the enumeration. */
export type DiffLineKind = (typeof DIFF_LINE_KINDS)[number];

/** The two ways a diff is laid out. Closed; both are renderer-local state. */
export const DIFF_VIEW_MODES = ["unified", "split"] as const;

/** One view mode. Derived from the enumeration. */
export type DiffViewMode = (typeof DIFF_VIEW_MODES)[number];

/**
 * One run of characters within a line, and whether it is part of what changed. A sequence
 * cannot describe an overlap or out-of-order span, which a string plus range list can.
 */
export interface DiffIntralineSegment {
  readonly text: string;
  /** True where this run is the intraline change, false where it is carried over. */
  readonly changed: boolean;
}

/** One line of one hunk. */
export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Line number in the base state. Absent on an inserted line. */
  readonly baseLineNumber?: number;
  /** Line number in the head state. Absent on a deleted line. */
  readonly headLineNumber?: number;
  /**
   * The line's text as segments. Producers supply one unchanged segment (the whole line);
   * the word-level split comes from `intraline-segment-cache.ts`. A line with no intraline
   * change is one segment, never an empty list.
   */
  readonly segments: readonly DiffIntralineSegment[];
  /**
   * True where the patch marked this line as the file's last, with no terminator (the
   * `\ No newline at end of file` marker, which sits on the line below in the patch). A
   * fact about the line: a patch that only adds or removes the final newline has identical
   * deleted and inserted text, and nothing else says what changed.
   */
  readonly noNewlineAtEnd?: boolean;
}

/**
 * One hunk plus the hidden context before it, which a gap expansion reveals. Carried on the
 * model, not fetched. An empty list means the hunk abuts its predecessor and no gap row is
 * drawn.
 */
export interface DiffHunk {
  /** Wire-verbatim hunk header, e.g. `@@ -1,7 +1,9 @@`. Rendered as received. */
  readonly header: string;
  /** The hidden context lines above this hunk, nearest-last. */
  readonly precedingContext: readonly DiffLine[];
  readonly lines: readonly DiffLine[];
}

/**
 * A file's mode on each side, where the patch declared a change. Both sides, because
 * `100755` alone does not say what changed. Wire-verbatim octal strings.
 */
export interface DiffFileModeChange {
  readonly from: string;
  readonly to: string;
}

/**
 * One file's change set. The extended-header members (rename, copy, mode, binary) are why a
 * file can have no hunks; they are carried rather than inferred from `hunks.length === 0`,
 * which cannot say which one it was. Each is absent where the patch did not declare it.
 */
export interface DiffFile {
  /** Wire-verbatim path, rendered as received and never re-rooted. */
  readonly path: string;
  /** Where a renamed file came from. The patch's `rename from`, path-verbatim. */
  readonly renamedFrom?: string;
  /**
   * Where a copied file came from (`copy from`, path-verbatim). Not folded into a rename:
   * git emits `copy from` only when the source still exists.
   */
  readonly copiedFrom?: string;
  /** The two modes, where the patch declared the file's mode changed. */
  readonly modeChange?: DiffFileModeChange;
  /** True where the patch states the two sides differ and carries no text for it. */
  readonly binary?: boolean;
  readonly hunks: readonly DiffHunk[];
}

/** A whole diff, as the pane and the inline card render it. */
export interface DiffModel {
  /** Wire-verbatim compared states. */
  readonly baseRef: string;
  readonly headRef: string;
  readonly files: readonly DiffFile[];
}

/** How many lines of each kind a file changes. Derived, never stored. */
export interface DiffFileChangeCounts {
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * A line with no intraline change: exactly one unchanged segment, as `DiffLine.segments`
 * promises. Every producer of an unsegmented line uses this.
 */
export function wholeLineSegments(text: string): readonly DiffIntralineSegment[] {
  return [{ text, changed: false }];
}

/** One line's text, reassembled from its segments. */
export function diffLineText(line: DiffLine): string {
  let text = "";
  for (const segment of line.segments) {
    text += segment.text;
  }
  return text;
}

/**
 * Count one file's changed lines over the hunks' own lines only: `precedingContext` is
 * context, so counting it would make totals depend on how much of the gaps a reader expanded.
 */
export function diffFileChangeCounts(file: DiffFile): DiffFileChangeCounts {
  let insertions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "insert") {
        insertions += 1;
      } else if (line.kind === "delete") {
        deletions += 1;
      }
    }
  }
  return { insertions, deletions };
}

/**
 * What a file's extended headers say changed about it, as the words a diff view draws. One
 * derivation for the list and the renderer, in git's header order (rename or copy, mode,
 * binary); empty for an ordinary textual change, where the counts already say it. A copy reads
 * `added`: its source stays where it was and the copy is a new path.
 */
export function diffFileChangeNotes(file: DiffFile): readonly string[] {
  const notes: string[] = [];
  if (file.renamedFrom !== undefined) {
    notes.push(`renamed from ${file.renamedFrom}`);
  }
  if (file.copiedFrom !== undefined) {
    notes.push("added");
  }
  if (file.modeChange !== undefined) {
    notes.push("mode changed");
  }
  if (file.binary === true) {
    notes.push("binary — contents not shown");
  }
  return notes;
}
