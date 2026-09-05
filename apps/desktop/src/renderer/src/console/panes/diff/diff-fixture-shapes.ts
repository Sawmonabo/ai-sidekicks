// The change-set shapes the diff surfaces are built and measured against, and the named
// fixtures a case reaches for by name.
//
// SPLIT FROM `diff-fixture.ts` ON THE SEAM BETWEEN A DESCRIPTION AND A BUILD. This
// module says what shapes exist — how many files, how many hunks, how much hidden
// context, whether a terminator file or an extended-header file is included — and holds
// the two attributions a fixture carries. Nothing here generates anything: the patch
// text is `diff-fixture-patch.ts`'s and the model is `diff-fixture.ts`'s. Declared with
// the builder, the shape and its generator could not be read apart, and the file was
// over the size at which one module is doing two jobs.
//
// THE SHAPES ARE GENERATED RATHER THAN TRANSCRIBED, because the endurance tier's
// subject is a forty-file, five-thousand-line change set and a transcription of one
// would be a hundred kilobytes of source nobody reads. Generation also makes the SIZE a
// parameter, so the same builder serves a two-line unit case and the endurance case
// with no second implementation.

import type { DiffAttribution } from "./diff-model.js";

/** What a generated change set looks like. Every field is a measured dimension. */
export interface DiffFixtureShape {
  readonly fileCount: number;
  readonly hunksPerFile: number;
  readonly linesPerHunk: number;
  /** Hidden context above each hunk, which is what a gap row offers to reveal. */
  readonly precedingContextPerHunk: number;
  /** Every nth line carries trailer-supplied agent attribution. Zero means none. */
  readonly agentAttributionEveryNthLine: number;
  /**
   * Whether the change set carries one file of each extended-header kind — renamed,
   * copied, mode-changed, and binary — each of them with no hunks at all.
   *
   * A DIMENSION OF ITS OWN RATHER THAN A WIDER `fileCount`, because these files
   * change no lines: folding them into that count would make every changed-line
   * figure derived from it wrong, and would move every existing shape's totals.
   * They are additional to `fileCount`, so a shape carrying `false` is exactly the
   * change set it was before this dimension existed.
   */
  readonly extendedHeaderFiles: boolean;
  /**
   * Whether the change set carries one file whose only change is its terminator.
   *
   * A DIMENSION OF ITS OWN for `extendedHeaderFiles`' reason and one more: this file
   * DOES change lines — one deleted and one inserted, with identical text — so folding
   * it into `fileCount` would move every existing shape's per-file arithmetic, and
   * folding it into the header dimension would put a hunk inside a set documented as
   * having none. It is the only subject in this module on which the two rendered rows
   * are indistinguishable without the patch's own `\ No newline at end of file`
   * marker, which is exactly why the surfaces need it.
   */
  readonly terminalNewlineFile: boolean;
}

/** The endurance tier's subject: forty files, five thousand changed lines. */
export const ENDURANCE_DIFF_SHAPE: DiffFixtureShape = {
  fileCount: 40,
  hunksPerFile: 5,
  linesPerHunk: 25,
  precedingContextPerHunk: 30,
  agentAttributionEveryNthLine: 7,
  extendedHeaderFiles: false,
  terminalNewlineFile: false,
};

/**
 * The other endurance shape: one file, one hunk, five thousand lines.
 *
 * The same five thousand changed lines as `ENDURANCE_DIFF_SHAPE` in the shape that
 * shape cannot express. Forty files of five twenty-five-line hunks bounds every
 * per-hunk cost at twenty-five, so a per-lookup flattening of a whole hunk stayed
 * invisible there; the cost a diff pane actually meets is a generated file, a
 * vendored lockfile, or a rewritten module, where one hunk holds the whole change.
 * Both shapes are kept because they measure different claims — that one is about
 * addressing across many spans, this one about the cost of addressing inside one.
 */
export const SINGLE_LARGE_HUNK_DIFF_SHAPE: DiffFixtureShape = {
  fileCount: 1,
  hunksPerFile: 1,
  linesPerHunk: 5_000,
  precedingContextPerHunk: 30,
  agentAttributionEveryNthLine: 7,
  extendedHeaderFiles: false,
  terminalNewlineFile: false,
};

/** A change set small enough to assert against row by row. */
export const SMALL_DIFF_SHAPE: DiffFixtureShape = {
  fileCount: 2,
  hunksPerFile: 2,
  linesPerHunk: 3,
  precedingContextPerHunk: 4,
  agentAttributionEveryNthLine: 3,
  extendedHeaderFiles: false,
  terminalNewlineFile: false,
};

/**
 * The small change set plus one file of every extended-header kind.
 *
 * A SHAPE OF ITS OWN RATHER THAN A WIDENED `SMALL_DIFF_SHAPE`, so the cases written
 * against that shape keep counting the files they were written to count. This one is
 * the subject both the render cases and the surface tiers take: a file with no hunks
 * reaches the file list and the row renderer as `+0 −0` under a bare path unless what
 * the patch declared is carried and drawn, which is exactly what an image holds and a
 * count assertion does not.
 */
export const EXTENDED_HEADER_DIFF_SHAPE: DiffFixtureShape = {
  ...SMALL_DIFF_SHAPE,
  extendedHeaderFiles: true,
  // And the file whose whole change is its terminating newline, for the same reason
  // the four header files are here: two rows with identical text are what the two
  // surfaces drew before the marker was carried, and what they draw now is a claim an
  // image holds and a count assertion does not.
  terminalNewlineFile: true,
};

/**
 * The four extended-header files, named once for the patch text and the cases both.
 *
 * The patch below is composed from these, so a case that addresses one of these files
 * addresses the file the fixture actually wrote — never a path restated beside it.
 */
export const EXTENDED_HEADER_FIXTURE_FILES = {
  renamed: { from: "docs/decisions/before.md", to: "docs/decisions/after.md" },
  copied: { from: "config/base.yml", to: "config/staging.yml" },
  modeChanged: { path: "scripts/release.sh", from: "100644", to: "100755" },
  binary: { path: "assets/logo.png" },
} as const;

/**
 * The file whose only change is whether its last line ends with a newline.
 *
 * Named once so a case addresses the file the fixture actually wrote, exactly as the
 * four header files are. `lastLine` is the text BOTH the deleted and the inserted row
 * carry — they are the same characters, which is the whole point of the subject.
 */
export const TERMINAL_NEWLINE_FIXTURE_FILE = {
  path: "packages/contracts/src/tail.ts",
  lastLine: "export const tail = terminate(entries);",
} as const;

/** The run-attributed arm, for the case the badge renders as accountable to a run. */
export const RUN_ATTRIBUTION: DiffAttribution = {
  mode: "run_attributed",
  runId: "run-rate-limit-wiring",
};

/** The workspace-fallback arm, which carries no run and must never be shown one. */
export const WORKSPACE_FALLBACK_ATTRIBUTION: DiffAttribution = {
  mode: "workspace_fallback",
  workspaceId: "workspace-sidekicks",
};

/** The compared states every generated change set names. */
