// What a diff IS to this console: the typed model both the pane and the inline
// card render, and the closed sets that make its illegal states unrepresentable.
//
// `DiffLine.segments` carries the line's TEXT, as one whole-line segment. jsdiff is
// adopted for parse and intraline compute over patch bytes; this family own-builds the
// row renderer and its virtualization. The word-level SPLIT of that text is derived per
// rendered row by `intraline-segment-cache.ts` — bounded, memoised, and never at parse time,
// because computing every pair up front costs the whole change set before the
// virtualizer has placed a row.

/** The three things a line in a unified diff can be. Closed. */
export const DIFF_LINE_KINDS = ["context", "insert", "delete"] as const;

/** One line kind. Derived from the enumeration. */
export type DiffLineKind = (typeof DIFF_LINE_KINDS)[number];

/** The two ways a diff is laid out. Closed; both are renderer-local state. */
export const DIFF_VIEW_MODES = ["unified", "split"] as const;

/** One view mode. Derived from the enumeration. */
export type DiffViewMode = (typeof DIFF_VIEW_MODES)[number];

/**
 * One run of characters within a line, and whether it is part of what changed.
 *
 * A line is a sequence of these rather than a string plus a range list, because a
 * range list has to be re-validated against the string at every render and a
 * sequence cannot describe an overlap or an out-of-order span at all.
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
   * The line's text, as a segment list rather than a string.
   *
   * A producer supplies ONE unchanged segment — the whole line — and a consumer
   * that wants the word-level split asks `intraline-segment-cache.ts` for it. The list
   * shape stays because the split has to be expressible in the same type the
   * renderer draws from, and because a line with no intraline change is one
   * unchanged segment rather than an empty list, so every consumer reads text the
   * same way.
   */
  readonly segments: readonly DiffIntralineSegment[];
  /**
   * True where the patch marked this line as the file's last, with no terminator.
   *
   * A FACT ABOUT THE LINE AND NOT A LINE OF ITS OWN. A unified patch spells it as a
   * `\ No newline at end of file` marker on the line BELOW the one it annotates, and
   * it is the entire content of some changes: a patch that only adds or removes a
   * terminating newline has a deleted line and an inserted line whose TEXT is
   * identical, so a renderer that dropped the marker drew two identical lines with
   * nothing to say what changed. Absent means the patch said nothing, which for every
   * line but a file's last is the only thing it could say.
   */
  readonly noNewlineAtEnd?: boolean;
}

/**
 * One hunk, plus the context that precedes it and is hidden until asked for.
 *
 * `precedingContext` is what a gap expansion reveals, and it is carried on the
 * model rather than fetched, because a gap the console cannot fill is a control
 * that refuses on activation — which is worse than a gap that states its size and
 * does nothing. An empty list means the hunk abuts its predecessor and no gap row
 * is drawn.
 */
export interface DiffHunk {
  /** Wire-verbatim hunk header, e.g. `@@ -1,7 +1,9 @@`. Rendered as received. */
  readonly header: string;
  /** The hidden context lines above this hunk, nearest-last. */
  readonly precedingContext: readonly DiffLine[];
  readonly lines: readonly DiffLine[];
}

/**
 * A file's mode on each side, where the patch declared that it changed.
 *
 * Both sides, because a mode change is only legible as a pair: `100755` on its own
 * says what the file is now and not what changed about it. Wire-verbatim octal
 * strings, rendered as the patch spelled them.
 */
export interface DiffFileModeChange {
  readonly from: string;
  readonly to: string;
}

/**
 * One file's change set.
 *
 * THE EXTENDED-HEADER MEMBERS ARE NOT DECORATION, AND THEY ARE WHY A FILE CAN HAVE
 * NO HUNKS AT ALL. A git patch states a rename, a copy, a mode change, and a binary
 * change in the headers ABOVE the hunks, and a change that is only one of those
 * produces a file with no textual hunks whatsoever. Carried on the model rather than
 * inferred from `hunks.length === 0`, which cannot say WHICH of the four it was — and
 * a file drawn as `+0 −0` with nothing beside it is the console reporting that
 * nothing happened to a file something happened to.
 *
 * Each is absent where the patch did not declare it, so presence IS the claim and
 * there is no arm meaning "declared, but nothing changed".
 */
export interface DiffFile {
  /** Wire-verbatim path, rendered as received and never re-rooted. */
  readonly path: string;
  /** Where a renamed file came from. The patch's `rename from`, path-verbatim. */
  readonly renamedFrom?: string;
  /**
   * Where a copied file came from. The patch's `copy from`, path-verbatim.
   *
   * A DIFFERENT FACT FROM A RENAME and not folded into it: git emits `copy from`
   * only when the source still exists, and reporting a copy as a rename would tell a
   * reader the original is gone.
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
 * A line with no intraline change: one unchanged segment, which every consumer handles.
 *
 * BESIDE THE SHAPE IT BUILDS, because the rule it enforces is this module's: "exactly
 * one segment" is what the interface above promises a consumer, and a constructor for
 * it declared next to one of its callers would make the promise something a reader has
 * to find. Every producer of an unsegmented line — the hunk reader, the intraline
 * cache's two skip arms, the fixture builder — reaches this one.
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
 * Count one file's changed lines.
 *
 * Over the hunks' own lines only: `precedingContext` is context by construction,
 * so counting it would make a file's totals depend on how much of its gaps a
 * reader had expanded.
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
 * What a file's extended headers say changed about it, as sentences a surface draws.
 *
 * ONE DERIVATION FOR BOTH SURFACES, because the file list and the row renderer must
 * not disagree about what a file's change is: two spellings of "renamed from" is two
 * places for one of them to go stale. Ordered rename-or-copy, mode, binary — the
 * order git writes the headers in, so a reader meeting both sees them in the order
 * the patch states them.
 *
 * Empty for an ordinary textual change, which is the common case: the counts beside
 * the path already say what happened and a note would be noise.
 */
export function diffFileChangeNotes(file: DiffFile): readonly string[] {
  const notes: string[] = [];
  if (file.renamedFrom !== undefined) {
    notes.push(`renamed from ${file.renamedFrom}`);
  }
  if (file.copiedFrom !== undefined) {
    notes.push(`copied from ${file.copiedFrom}`);
  }
  if (file.modeChange !== undefined) {
    notes.push(`mode ${file.modeChange.from} → ${file.modeChange.to}`);
  }
  if (file.binary === true) {
    notes.push("binary file changed");
  }
  return notes;
}
