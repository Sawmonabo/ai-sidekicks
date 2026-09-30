// The changed-file list's rows and the index the window, keyboard and selection share,
// driven without rendering a pane.

import { describe, expect, it } from "vitest";

import { diffFileListReading, selectedEntryRow } from "./diff-file-entries.js";
import { buildDiffFixture } from "@test/helpers/diff-fixture.js";
import { SMALL_DIFF_SHAPE } from "@test/helpers/diff-fixture-shapes.js";

const DIFF = buildDiffFixture(SMALL_DIFF_SHAPE);
const FIRST_PATH = DIFF.files[0]?.path ?? "";

describe("diffFileListReading", () => {
  it("opens on the reset control and counts every file the change set holds", () => {
    const { entries, matchCount } = diffFileListReading(DIFF, "");
    expect(entries[0]).toStrictEqual({ kind: "all-files", fileCount: SMALL_DIFF_SHAPE.fileCount });
    expect(entries).toHaveLength(SMALL_DIFF_SHAPE.fileCount + 1);
    expect(matchCount).toBe(SMALL_DIFF_SHAPE.fileCount);
  });

  it("keeps the reset control counting the whole change set under a filter", () => {
    // The count is what the control does (clear the narrowing); a count that followed the
    // filter would report the change set as smaller than it is.
    const { entries, matchCount } = diffFileListReading(DIFF, "module-01");
    expect(entries[0]).toStrictEqual({ kind: "all-files", fileCount: SMALL_DIFF_SHAPE.fileCount });
    expect(matchCount).toBe(1);
  });

  it("matches the wire-verbatim path, case-insensitively and on a substring", () => {
    expect(diffFileListReading(DIFF, "  MODULE-01  ").matchCount).toBe(1);
  });
});

describe("selectedEntryRow", () => {
  it("finds the row a selected path is on", () => {
    expect(selectedEntryRow(diffFileListReading(DIFF, "").entries, FIRST_PATH)).toStrictEqual({
      kind: "row",
      index: 1,
    });
  });

  it("answers that the filter hides the narrowing rather than naming another row", () => {
    // Row zero clears the narrowing, so answering it for a hidden narrowing would mark "All
    // files" current while the renderer still shows the hidden file.
    const { entries } = diffFileListReading(DIFF, "module-01");
    expect(selectedEntryRow(entries, FIRST_PATH)).toStrictEqual({ kind: "hidden-by-filter" });
  });
});
