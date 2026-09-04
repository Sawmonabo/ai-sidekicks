// What a diff IS to this console: the typed model both the pane and the inline
// card render, and the closed sets that make its illegal states unrepresentable.
//
// THE ATTRIBUTION AXIS IS A UNION, NOT A FLAG. `Spec-011 §Implementation Notes`
// makes attribution quality a first-class field rather than an inferred
// decoration, and `Spec-011 §Pitfalls To Avoid` names pretending a workspace diff
// is run-attributed. So the two arms carry DIFFERENT identity — the
// `run_attributed` arm a run, the `workspace_fallback` arm a workspace — and
// there is no arm carrying both and no arm carrying neither. A renderer cannot
// display a run for a workspace-fallback diff because there is no run on that arm
// to read, which is the point: the union makes the wrong shape unrepresentable
// and the renderer does not undo that.
//
// WHERE THE VALUES COME FROM, AND WHAT IS NOT BUILT HERE. Nothing on the wire
// produces one of these yet. `gitflow.diffArtifactCreate` is a `Plan-023 §Console
// growth slate` row (`gitflow-actions`, owned by Spec-011), the contracts package
// exports no `gitflow` module, and the growth port registers no operation for it —
// so this model is the shape the surfaces are built against and its producer is
// somebody else's. Two consequences are deliberate:
//
//   • `DiffLine.segments` carries the line's TEXT, as one whole-line segment.
//     `Spec-023 §Console Libraries` adopts jsdiff for "parse and intraline
//     compute" over patch bytes; this family own-builds the row renderer and its
//     virtualization. The module that turns a unified patch into this model lands
//     with the first caller that has patch bytes to give it, in the PR that adds
//     that dependency. The word-level SPLIT of that text is derived per rendered
//     row by `intraline-segments.ts` — bounded, memoised, and never at parse time,
//     because computing every pair up front costs the whole change set before the
//     virtualizer has placed a row.
//   • The per-line agent attribution arrives on the line. `Spec-011 §Required
//     Behavior` names the Agent Trace standard and the `Agent-Run:` and
//     `Co-authored-by:` git trailers as the provenance source; the console
//     RENDERS what the trailers supplied and derives attribution from nothing
//     else — there is no fallback that guesses an agent for an unmarked line.

/**
 * How the daemon attributed this diff. Closed at two, because `Spec-011` fixes
 * exactly two answers and a third would be a spec amendment.
 *
 * The tuple is the declaration and the union is derived from it, so a mode cannot
 * be added to a hand-written union while the list a badge iterates stays at two.
 */
export const DIFF_ATTRIBUTION_MODES = ["run_attributed", "workspace_fallback"] as const;

/** One attribution mode. Derived from the enumeration, never restated. */
export type DiffAttributionMode = (typeof DIFF_ATTRIBUTION_MODES)[number];

/** A diff the daemon attributed to a run. */
export interface RunAttributedDiff {
  readonly mode: "run_attributed";
  /** Wire-verbatim run id. The only arm on which a run exists to render. */
  readonly runId: string;
}

/** A diff the daemon could only attribute to a workspace. */
export interface WorkspaceFallbackDiff {
  readonly mode: "workspace_fallback";
  /** Wire-verbatim workspace id. This arm carries no run, by construction. */
  readonly workspaceId: string;
}

/** Which subject a diff is accountable to. Narrow on `mode`. */
export type DiffAttribution = RunAttributedDiff | WorkspaceFallbackDiff;

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

/**
 * Who the trailers say wrote this line.
 *
 * Present only where the daemon supplied it. Absence means the trailers named
 * nobody for this line — never that the line is unattributed to a person, and
 * never a reason to fall back to the diff's own run.
 */
export interface DiffLineAgentAttribution {
  /** Wire-verbatim, from the `Agent-Run:` trailer. */
  readonly agentRunId: string;
  /** Wire-verbatim, from the `Co-authored-by:` trailer. */
  readonly agentName: string;
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
   * that wants the word-level split asks `intraline-segments.ts` for it. The list
   * shape stays because the split has to be expressible in the same type the
   * renderer draws from, and because a line with no intraline change is one
   * unchanged segment rather than an empty list, so every consumer reads text the
   * same way.
   */
  readonly segments: readonly DiffIntralineSegment[];
  readonly agentAttribution?: DiffLineAgentAttribution;
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
export interface ConsoleDiffModel {
  readonly attribution: DiffAttribution;
  /** Wire-verbatim compared states. `Spec-011 §Interfaces And Contracts`. */
  readonly baseRef: string;
  readonly headRef: string;
  readonly files: readonly DiffFile[];
}

/** One line's text, reassembled from its segments. */
export function diffLineText(line: DiffLine): string {
  let text = "";
  for (const segment of line.segments) {
    text += segment.text;
  }
  return text;
}

/** How many lines of each kind a file changes. Derived, never stored. */
export interface DiffFileChangeCounts {
  readonly insertions: number;
  readonly deletions: number;
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

/**
 * The subject a diff's attribution names, as an entity kind and a wire-verbatim
 * id.
 *
 * One reader for both arms, so a surface that shows "who this is accountable to"
 * never has to branch — and, more to the point, never has a branch in which it
 * could reach for a run on the workspace arm.
 */
export function diffAttributionSubjectId(attribution: DiffAttribution): string {
  return attribution.mode === "run_attributed" ? attribution.runId : attribution.workspaceId;
}
