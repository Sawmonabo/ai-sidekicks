// The change-set shapes the diff views are built and measured against, and the named fixtures a
// case reaches for by name.
//
// This module says what shapes exist; the patch text is `patch.test-support.ts`'s and
// the model is `model.ts`'s. Shapes are generated rather than transcribed, and size is a
// parameter, so one builder serves a two-line unit case and the forty-file endurance case.

/** What a generated change set looks like. Every field is a measured dimension. */
export interface DiffFixtureShape {
  readonly fileCount: number;
  readonly hunksPerFile: number;
  readonly linesPerHunk: number;
  /** Hidden context above each hunk, which is what a gap row offers to reveal. */
  readonly precedingContextPerHunk: number;
  /**
   * Whether the change set carries one file of each extended-header kind (renamed, copied,
   * mode-changed, binary), each with no hunks.
   *
   * Additional to `fileCount`, so changed-line figures derived from it stay right.
   */
  readonly extendedHeaderFiles: boolean;
  /**
   * Whether the change set carries one file whose only change is its terminator.
   *
   * Separate from `fileCount` and from the header dimension because this file does change lines
   * (one deleted, one inserted, identical text). The two rendered rows are indistinguishable
   * without the patch's `\ No newline at end of file` marker.
   */
  readonly terminalNewlineFile: boolean;
}

/** The endurance tier's subject: forty files, five thousand changed lines. */
export const ENDURANCE_DIFF_SHAPE: DiffFixtureShape = {
  fileCount: 40,
  hunksPerFile: 5,
  linesPerHunk: 25,
  precedingContextPerHunk: 30,
  extendedHeaderFiles: false,
  terminalNewlineFile: false,
};

/**
 * The other endurance shape: one file, one hunk, five thousand lines.
 *
 * Forty short hunks bound every per-hunk cost at twenty-five lines; a diff pane also meets a
 * generated file or lockfile where one hunk holds the whole change, and this shape measures
 * addressing inside one hunk.
 */
export const SINGLE_LARGE_HUNK_DIFF_SHAPE: DiffFixtureShape = {
  fileCount: 1,
  hunksPerFile: 1,
  linesPerHunk: 5_000,
  precedingContextPerHunk: 30,
  extendedHeaderFiles: false,
  terminalNewlineFile: false,
};

/** A change set small enough to assert against row by row. */
export const SMALL_DIFF_SHAPE: DiffFixtureShape = {
  fileCount: 2,
  hunksPerFile: 2,
  linesPerHunk: 3,
  precedingContextPerHunk: 4,
  extendedHeaderFiles: false,
  terminalNewlineFile: false,
};

/**
 * The small change set plus one file of every extended-header kind.
 *
 * A separate shape so cases written against `SMALL_DIFF_SHAPE` keep counting the files they count.
 * A file with no hunks would reach the file list as `+0 −0` under a bare path unless what the
 * patch declared is carried and drawn.
 */
export const EXTENDED_HEADER_DIFF_SHAPE: DiffFixtureShape = {
  ...SMALL_DIFF_SHAPE,
  extendedHeaderFiles: true,
  // Also the file whose whole change is its terminating newline.
  terminalNewlineFile: true,
};

/**
 * The four extended-header files, named once for the patch text and the cases.
 *
 * A case that addresses one of these addresses the file the fixture actually wrote.
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
 * `lastLine` is the text both the deleted and the inserted row carry.
 */
export const TERMINAL_NEWLINE_FIXTURE_FILE = {
  path: "packages/contracts/src/tail.ts",
  lastLine: "export const tail = terminate(entries);",
} as const;
