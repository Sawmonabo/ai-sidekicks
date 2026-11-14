// The typed diff model both the pane and the inline card render, and the closed sets that
// make its illegal states unrepresentable. The word-level split of a line's text is derived
// per rendered row by `intraline/segment-cache.ts`, never at parse time, because computing
// every pair up front costs the whole change set before the virtualizer places a row.

import type {
  DiffFile as WireDiffFile,
  DiffFileUnreadableReason,
} from "@ai-sidekicks/contracts/git/local";

import { NO_PREVIEW_LINE } from "#renderer/lib/no-preview.js";

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
   * the word-level split comes from `intraline/segment-cache.ts`. A line with no intraline
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
 * What happened to a file, in the daemon's words: added, deleted, renamed or only modified. A
 * rename carries the path it came from, path-verbatim, so a rename with no old path cannot be
 * written down.
 */
export type DiffFileChange =
  | { readonly kind: Exclude<WireDiffFile["kind"], "renamed"> }
  | { readonly kind: "renamed"; readonly renamedFrom: string };

/**
 * Why a tool call's patch for a file cannot be drawn: none came, one came in a form this version
 * cannot read (kept as the provider sent it), or the log cannot read its stored text back.
 */
export type DiffPatchUnavailable =
  | { readonly reason: "absent" | "damaged" }
  | { readonly reason: "unreadable"; readonly rawPatch: string };

/**
 * One file's change set. The extended-header members (mode, binary) and the change are why a
 * file can have no hunks; they are carried rather than inferred from `hunks.length === 0`,
 * which cannot say which one it was. Each optional one is absent where nothing declared it.
 */
export interface DiffFile {
  /** Wire-verbatim path, rendered as received and never re-rooted. */
  readonly path: string;
  readonly change: DiffFileChange;
  /** True where the file's mode changed, whether or not it has lines to draw. */
  readonly modeChanged?: boolean;
  /** True where the patch states the two sides differ and carries no text for it. */
  readonly binary?: boolean;
  /** Why the daemon could not read the file's contents, where it could not. */
  readonly unreadable?: DiffFileUnreadableReason;
  /** Why a tool call's patch for the file cannot be drawn, where it cannot. */
  readonly patchUnavailable?: DiffPatchUnavailable;
  /** On a workflow run's comparison, the name of the step that changed the file. */
  readonly stepName?: string;
  /**
   * The file's own unified patch, wire-verbatim: what a copy of the patch lifts, whole even
   * where only part of it is drawn. Absent where the wire carried none.
   */
  readonly patch?: string;
  readonly hunks: readonly DiffHunk[];
}

/** A whole diff, as the pane and the inline card render it. */
export interface DiffModel {
  /** Wire-verbatim compared states. */
  readonly baseRef: string;
  readonly headRef: string;
  readonly files: readonly DiffFile[];
}

/** Where a file's kind words are drawn: on its header in the diff, or on its row in the list. */
export type DiffFileNotePlace = "header" | "row";

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
 * What changed about a file, as the words drawn at `place`: its kind word, then a mode change;
 * empty for a file that was only edited, where the counts already say it. A rename names its old
 * path on the header and reads `renamed` on the narrower row.
 */
export function diffFileChangeNotes(file: DiffFile, place: DiffFileNotePlace): readonly string[] {
  const notes: string[] = [];
  const { change } = file;
  if (change.kind === "renamed") {
    notes.push(place === "header" ? `renamed from ${change.renamedFrom}` : "renamed");
  } else if (change.kind !== "modified") {
    notes.push(change.kind);
  }
  if (file.modeChanged === true) {
    notes.push("mode changed");
  }
  return notes;
}

/**
 * Why a file's contents are not drawn, in the console's own words, written where its lines would
 * be: binary contents, the cause the daemon could not read them, or why a tool call's patch
 * cannot be drawn; absent for a file whose lines can be drawn.
 */
export function diffFileUnshownReason(file: DiffFile): string | undefined {
  if (file.binary === true) {
    return NO_PREVIEW_LINE;
  }
  if (file.unreadable !== undefined) {
    return UNREADABLE_REASON_COPY[file.unreadable];
  }
  return file.patchUnavailable === undefined
    ? undefined
    : PATCH_UNAVAILABLE_COPY[file.patchUnavailable.reason];
}

/**
 * The text a file's `Copy patch` lifts: its patch, or a patch this version cannot read as the
 * provider sent it; absent where there is nothing to copy.
 */
export function diffFileCopiedPatch(file: DiffFile): string | undefined {
  return file.patchUnavailable?.reason === "unreadable"
    ? file.patchUnavailable.rawPatch
    : file.patch;
}

/** What a file the daemon could not read says, naming the cause in the console's own words. */
const UNREADABLE_REASON_COPY: Readonly<Record<DiffFileUnreadableReason, string>> = {
  permissionDenied: "Permission denied",
  notRegularFile: "Not a regular file",
};

/** What a file whose tool-call patch cannot be drawn says, one line per reason. */
const PATCH_UNAVAILABLE_COPY: Readonly<Record<DiffPatchUnavailable["reason"], string>> = {
  absent: "no patch was sent for this file",
  unreadable: "this version cannot read this change — shown as sent",
  damaged: "this change's stored text is damaged",
};
