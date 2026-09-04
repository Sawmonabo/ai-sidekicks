// The rows the changed-file list holds, and the index the window addresses them by.
//
// Driven directly rather than through the component, which is the point of the model
// being a module: the window, the keyboard, and the selection all address the same
// index space, and a case that had to render a pane to check an off-by-one would be
// checking the DOM's arithmetic rather than the list's.

import { describe, expect, it } from "vitest";

import { diffFileListReading, selectedEntryIndex } from "./diff-file-entries.js";
import {
  EXTENDED_HEADER_FIXTURE_FILES,
  SMALL_DIFF_SHAPE,
  buildDiffFixture,
} from "./diff-fixture.js";

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
    // The count is what the control DOES — clear the narrowing — and a count that
    // followed the filter would report the change set as smaller than it is.
    const { entries, matchCount } = diffFileListReading(DIFF, "module-01");
    expect(entries[0]).toStrictEqual({ kind: "all-files", fileCount: SMALL_DIFF_SHAPE.fileCount });
    expect(matchCount).toBe(1);
  });

  it("matches the wire-verbatim path, case-insensitively and on a substring", () => {
    expect(diffFileListReading(DIFF, "  MODULE-01  ").matchCount).toBe(1);
  });

  it("carries what the extended headers said, for the surfaces that draw it", () => {
    const { renamed } = EXTENDED_HEADER_FIXTURE_FILES;
    const { entries } = diffFileListReading(
      buildDiffFixture({ ...SMALL_DIFF_SHAPE, extendedHeaderFiles: true }),
      renamed.to,
    );
    expect(entries[1]).toMatchObject({
      kind: "file",
      path: renamed.to,
      changeNotes: [`renamed from ${renamed.from}`],
    });
  });

  it("negative control: a filter matching nothing still leaves the reset control", () => {
    // Without this, a reading that returned an empty sequence for a filter nobody
    // matched would leave the list with no way back to the whole change set.
    const { entries, matchCount } = diffFileListReading(DIFF, "no-such-path");
    expect(matchCount).toBe(0);
    expect(entries).toStrictEqual([{ kind: "all-files", fileCount: SMALL_DIFF_SHAPE.fileCount }]);
  });
});

describe("selectedEntryIndex", () => {
  it("puts the whole change set on row zero", () => {
    expect(selectedEntryIndex(diffFileListReading(DIFF, "").entries, undefined)).toBe(0);
  });

  it("finds the row a selected path is on", () => {
    expect(selectedEntryIndex(diffFileListReading(DIFF, "").entries, FIRST_PATH)).toBe(1);
  });

  it("negative control: a selection the filter hid falls back to row zero", () => {
    // Without this a hidden selection would answer `-1`, and the window would open at
    // a negative offset while the keyboard started on a row that is not there.
    const { entries } = diffFileListReading(DIFF, "module-01");
    expect(selectedEntryIndex(entries, FIRST_PATH)).toBe(0);
  });
});
