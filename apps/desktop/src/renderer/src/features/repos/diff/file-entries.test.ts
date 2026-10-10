// The changed-file list's rows and the index the window, keyboard and selection share,
// driven without rendering a pane.

import { describe, expect, it } from "vitest";

import { diffFileListReading, selectedEntryRow } from "./file-entries.js";
import { buildDiffFixture } from "#test/helpers/diff/fixture/model.js";
import {
  EXTENDED_HEADER_DIFF_SHAPE,
  EXTENDED_HEADER_FIXTURE_FILES,
  SMALL_DIFF_SHAPE,
} from "#test/helpers/diff/fixture/shapes.js";

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
    // The count is what the control does (clear the one-file filter); a count that followed the
    // filter would report the change set as smaller than it is.
    const { entries, matchCount } = diffFileListReading(DIFF, "module-01");
    expect(entries[0]).toStrictEqual({ kind: "all-files", fileCount: SMALL_DIFF_SHAPE.fileCount });
    expect(matchCount).toBe(1);
  });

  it("gives a binary file its kind words alone: no zero counts, and no reason on its row", () => {
    const { path } = EXTENDED_HEADER_FIXTURE_FILES.binary;
    const { entries } = diffFileListReading(buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE), path);
    expect(entries[1]).toStrictEqual({ kind: "file", path, changeNotes: [] });
    // A file with lines keeps its counts.
    expect(diffFileListReading(DIFF, "module-01").entries[1]).toHaveProperty("counts");
  });

  it("reads a rename as renamed on its row, leaving the old path to the file's header", () => {
    const { renamed } = EXTENDED_HEADER_FIXTURE_FILES;
    const { entries } = diffFileListReading(
      buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE),
      renamed.to,
    );
    expect(entries[1]).toHaveProperty("changeNotes", ["renamed"]);
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

  it("answers that the filter hides the shown file rather than naming another row", () => {
    // Row zero clears the one-file filter, so answering it for a hidden shown file would mark "All
    // files" current while the renderer still shows the hidden file.
    const { entries } = diffFileListReading(DIFF, "module-01");
    expect(selectedEntryRow(entries, FIRST_PATH)).toStrictEqual({ kind: "hidden-by-filter" });
  });
});
