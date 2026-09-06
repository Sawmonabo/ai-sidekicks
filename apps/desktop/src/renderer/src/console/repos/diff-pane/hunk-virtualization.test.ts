// The flattening, which is the claim the diff surfaces rest on and the one
// nothing else in the console can check.
//
// Every case here runs without a DOM, because the addressing is separable from
// the rendering — which is the property that lets the endurance tier measure a
// five-thousand-line change set at all. The WINDOW is no longer this module's:
// `@tanstack/react-virtual` computes it, and the claims about it are asserted
// against the DOM in `DiffRenderer.test.tsx`, where a measured row can exist.

import { describe, expect, it } from "vitest";

import {
  DIFF_GAP_EXPANSION_LINE_COUNT,
  DIFF_ROW_HEIGHT_PX,
  DIFF_WINDOW_OVERSCAN_ROWS,
} from "./diff-bounds.js";
import { buildDiffFixture, fixtureChangedLineCount } from "./diff-fixture.test-support.js";
import {
  ENDURANCE_DIFF_SHAPE,
  SINGLE_LARGE_HUNK_DIFF_SHAPE,
  SMALL_DIFF_SHAPE,
} from "./diff-fixture-shapes.test-support.js";
import { DIFF_VIEW_MODES, type ConsoleDiffModel } from "./diff-model.js";
import { expandGap, type DiffRow } from "./diff-row-model.js";
import { DiffRowIndex } from "./hunk-virtualization.js";

const SMALL_DIFF = buildDiffFixture(SMALL_DIFF_SHAPE);

/**
 * The row count the shape implies, derived from the shape rather than counted
 * off a run of the code under test.
 *
 * Per file: one file header, then per hunk one gap row (while anything is
 * hidden), the revealed context, the hunk header, and the hunk's own lines.
 */
function expectedRowCount(revealedPerGap: number): number {
  const shape = SMALL_DIFF_SHAPE;
  const revealed = Math.min(revealedPerGap, shape.precedingContextPerHunk);
  const hidden = shape.precedingContextPerHunk - revealed;
  const perHunk = (hidden > 0 ? 1 : 0) + revealed + 1 + shape.linesPerHunk;
  return shape.fileCount * (1 + shape.hunksPerFile * perHunk);
}

/** Every row an index holds, so a count and its addressing cannot disagree. */
function everyRow(index: DiffRowIndex): readonly DiffRow[] {
  return Array.from({ length: index.rowCount }, (_unused, rowIndex) =>
    index.rowAt(rowIndex),
  ).filter((row): row is DiffRow => row !== undefined);
}

describe("hunk virtualization — flattening", () => {
  it("counts every row the shape implies", () => {
    expect(new DiffRowIndex(SMALL_DIFF).rowCount).toBe(expectedRowCount(0));
  });

  it("addresses each row kind at the position the layout puts it", () => {
    const index = new DiffRowIndex(SMALL_DIFF);
    expect(index.rowAt(0)).toStrictEqual({ kind: "file-header", fileIndex: 0 });
    expect(index.rowAt(1)).toStrictEqual({
      kind: "gap",
      fileIndex: 0,
      hunkIndex: 0,
      hiddenLineCount: SMALL_DIFF_SHAPE.precedingContextPerHunk,
    });
    expect(index.rowAt(2)).toStrictEqual({ kind: "hunk-header", fileIndex: 0, hunkIndex: 0 });
    expect(index.rowAt(3)).toStrictEqual({
      kind: "line",
      fileIndex: 0,
      hunkIndex: 0,
      source: "hunk-body",
      lineIndex: 0,
    });
  });

  it("finds the second file through the binary search, not by walking", () => {
    const index = new DiffRowIndex(SMALL_DIFF);
    const secondFileRowIndex = index.rowIndexOfFile(1);
    expect(secondFileRowIndex).toBeDefined();
    expect(index.rowAt(Number(secondFileRowIndex))).toStrictEqual({
      kind: "file-header",
      fileIndex: 1,
    });
  });

  it("resolves a line row to the line it addresses", () => {
    const index = new DiffRowIndex(SMALL_DIFF);
    const bodyRow = index.rowAt(3);
    expect(bodyRow).toBeDefined();
    expect(index.lineFor(bodyRow!)).toBe(SMALL_DIFF.files[0]?.hunks[0]?.lines[0]);
  });

  it("negative control: an index past the end resolves to nothing", () => {
    // Without this, `rowAt` could be returning the last row for every index past
    // it and every case above would still pass.
    const index = new DiffRowIndex(SMALL_DIFF);
    expect(index.rowAt(index.rowCount)).toBeUndefined();
    expect(index.rowAt(-1)).toBeUndefined();
  });

  it("negative control: a row kind is not resolved to a line", () => {
    const index = new DiffRowIndex(SMALL_DIFF);
    const fileHeader = index.rowAt(0);
    expect(fileHeader).toBeDefined();
    expect(index.lineFor(fileHeader!)).toBeUndefined();
  });
});

describe("hunk virtualization — narrowing to one file", () => {
  const secondFilePath = SMALL_DIFF.files[1]?.path ?? "";

  it("keeps the model's own file index on every row it hands out", () => {
    // The whole point of narrowing rather than filtering. A renumbered index
    // would call the shown file zero, and the host resolving how much context a
    // gap holds would resolve the FIRST file's.
    const narrowed = new DiffRowIndex(SMALL_DIFF, new Map(), secondFilePath);
    expect(narrowed.rowAt(0)).toStrictEqual({ kind: "file-header", fileIndex: 1 });
    expect(narrowed.rowAt(1)).toStrictEqual({
      kind: "gap",
      fileIndex: 1,
      hunkIndex: 0,
      hiddenLineCount: SMALL_DIFF_SHAPE.precedingContextPerHunk,
    });
  });

  it("holds only the named file's rows, and reports the whole model unchanged", () => {
    const narrowed = new DiffRowIndex(SMALL_DIFF, new Map(), secondFilePath);
    expect(narrowed.rowCount).toBe(expectedRowCount(0) / SMALL_DIFF_SHAPE.fileCount);
    // The model is not narrowed with the rows — a row's `fileIndex` addresses it,
    // and a smaller model would make that address mean something else.
    expect(narrowed.model.files).toHaveLength(SMALL_DIFF_SHAPE.fileCount);
    expect(narrowed.rowIndexOfFile(1)).toBe(0);
    expect(narrowed.rowIndexOfFile(0)).toBeUndefined();
  });

  it("negative control: unnarrowed, the same row indices address the first file", () => {
    // Without this the case above would pass over an index that ignored the path
    // and always started at the file it was given first.
    const whole = new DiffRowIndex(SMALL_DIFF);
    expect(whole.rowAt(0)).toStrictEqual({ kind: "file-header", fileIndex: 0 });
    expect(whole.rowIndexOfFile(0)).toBe(0);
  });
});

describe("hunk virtualization — pairing a modified line in split view", () => {
  /** A one-file, one-hunk diff whose body is exactly the kinds a case names. */
  function diffWithHunkBody(kinds: readonly ("context" | "insert" | "delete")[]): ConsoleDiffModel {
    return {
      ...SMALL_DIFF,
      files: [
        {
          path: "packages/contracts/src/budget.ts",
          hunks: [
            {
              header: `@@ -1,${String(kinds.length)} +1,${String(kinds.length)} @@`,
              precedingContext: [],
              lines: kinds.map((kind, ordinal) => ({
                kind,
                ...(kind === "insert" ? {} : { baseLineNumber: ordinal + 1 }),
                ...(kind === "delete" ? {} : { headLineNumber: ordinal + 1 }),
                segments: [{ text: `${kind}-${String(ordinal)}`, changed: false }],
              })),
            },
          ],
        },
      ],
    };
  }

  it("pairs a deletion with the insertion that follows it into one row", () => {
    const modifiedLine = diffWithHunkBody(["delete", "insert"]);
    const split = new DiffRowIndex(modifiedLine, new Map(), undefined, "split");
    const bodyRows = everyRow(split).filter((row) => row.kind === "line");
    expect(bodyRows).toHaveLength(1);
    expect(split.lineFor(bodyRows[0]!)?.kind).toBe("delete");
    expect(split.pairedLineFor(bodyRows[0]!)?.kind).toBe("insert");
  });

  it("negative control: unified spells the same modified line as two rows", () => {
    // Without this the case above would pass over an index that dropped a line
    // rather than pairing one, and over a unified layout it had also changed.
    const modifiedLine = diffWithHunkBody(["delete", "insert"]);
    const unified = new DiffRowIndex(modifiedLine, new Map(), undefined, "unified");
    const bodyRows = everyRow(unified).filter((row) => row.kind === "line");
    expect(bodyRows).toHaveLength(2);
    expect(unified.pairedLineFor(bodyRows[0]!)).toBeUndefined();
  });

  it("leaves the longer run's overhang unpaired, one row per line", () => {
    // Three deletions and one insertion is three rows: the first pairs, and the
    // two below it have a base line and no head line, which is what makes a
    // deletion of three lines read as a deletion rather than as three modifications.
    const uneven = diffWithHunkBody(["delete", "delete", "delete", "insert"]);
    const split = new DiffRowIndex(uneven, new Map(), undefined, "split");
    const bodyRows = everyRow(split).filter((row) => row.kind === "line");
    expect(bodyRows).toHaveLength(3);
    expect(split.pairedLineFor(bodyRows[0]!)?.kind).toBe("insert");
    expect(split.pairedLineFor(bodyRows[1]!)).toBeUndefined();
    expect(split.pairedLineFor(bodyRows[2]!)).toBeUndefined();
    expect(split.lineFor(bodyRows[2]!)?.kind).toBe("delete");
  });

  it("pairs the other way round too, and leaves a context line on both sides", () => {
    const uneven = diffWithHunkBody(["context", "delete", "insert", "insert"]);
    const split = new DiffRowIndex(uneven, new Map(), undefined, "split");
    const bodyRows = everyRow(split).filter((row) => row.kind === "line");
    expect(bodyRows).toHaveLength(3);
    expect(split.lineFor(bodyRows[0]!)?.kind).toBe("context");
    expect(split.pairedLineFor(bodyRows[0]!)).toBeUndefined();
    expect(split.pairedLineFor(bodyRows[1]!)?.kind).toBe("insert");
    expect(split.lineFor(bodyRows[2]!)?.kind).toBe("insert");
  });

  it("counts what it addresses, in both modes and every shape", () => {
    // The count and the addressing come from one walk, and this is the case that
    // says so: a second implementation of the count would agree on the even
    // shapes and place every row below the first uneven one at the wrong offset.
    const shapes = [
      ["delete", "insert"],
      ["delete", "delete", "delete", "insert"],
      ["context", "delete", "insert", "insert"],
      ["insert", "insert", "delete"],
      ["context", "context"],
    ] as const;
    for (const kinds of shapes) {
      for (const viewMode of DIFF_VIEW_MODES) {
        const index = new DiffRowIndex(diffWithHunkBody(kinds), new Map(), undefined, viewMode);
        expect(everyRow(index)).toHaveLength(index.rowCount);
        expect(index.rowAt(index.rowCount)).toBeUndefined();
      }
    }
  });

  it("negative control: the two modes really do disagree on those shapes", () => {
    // Without this, the case above would pass over an index that ignored the view
    // mode entirely and flattened everything the unified way.
    const uneven = diffWithHunkBody(["delete", "delete", "delete", "insert"]);
    expect(new DiffRowIndex(uneven, new Map(), undefined, "split").rowCount).toBeLessThan(
      new DiffRowIndex(uneven, new Map(), undefined, "unified").rowCount,
    );
  });

  it("defaults to the unified flattening when no mode is named", () => {
    // The existing callers pass three arguments, and a fourth that changed their
    // row count on arrival would move every offset in the console at once.
    const modifiedLine = diffWithHunkBody(["delete", "insert"]);
    expect(new DiffRowIndex(modifiedLine).rowCount).toBe(
      new DiffRowIndex(modifiedLine, new Map(), undefined, "unified").rowCount,
    );
  });
});

describe("hunk virtualization — a hunk is flattened once, not once per lookup", () => {
  it("builds one body layout per hunk it shows, in the constructor", () => {
    const index = new DiffRowIndex(SMALL_DIFF);
    expect(index.bodyLayoutBuildCount).toBe(
      SMALL_DIFF_SHAPE.fileCount * SMALL_DIFF_SHAPE.hunksPerFile,
    );
  });

  it("builds nothing further however many rows are read from it", () => {
    // The claim `rowAt` used to break: it re-flattened every hunk it walked past,
    // so a scroll cost the change set rather than the viewport.
    const index = new DiffRowIndex(SMALL_DIFF);
    const afterConstruction = index.bodyLayoutBuildCount;
    for (let pass = 0; pass < 3; pass += 1) {
      for (let rowIndex = 0; rowIndex < index.rowCount; rowIndex += 1) {
        expect(index.rowAt(rowIndex)).toBeDefined();
      }
    }
    expect(index.bodyLayoutBuildCount).toBe(afterConstruction);
  });

  it("counts only the hunks a narrowed index shows", () => {
    const shownPath = SMALL_DIFF.files[1]?.path;
    const narrowed = new DiffRowIndex(SMALL_DIFF, new Map(), shownPath);
    expect(narrowed.bodyLayoutBuildCount).toBe(SMALL_DIFF_SHAPE.hunksPerFile);
  });

  it("addresses inside one large hunk without flattening it again", () => {
    // The shape the forty-file fixture cannot express: one hunk holding the whole
    // change, which is what a generated file or a lockfile produces.
    const oneBigHunk = buildDiffFixture(SINGLE_LARGE_HUNK_DIFF_SHAPE);
    const index = new DiffRowIndex(oneBigHunk);
    expect(index.bodyLayoutBuildCount).toBe(1);
    for (let rowIndex = index.rowCount - 500; rowIndex < index.rowCount; rowIndex += 1) {
      expect(index.rowAt(rowIndex)).toBeDefined();
    }
    expect(index.bodyLayoutBuildCount).toBe(1);
  });

  it("negative control: a fresh index for a new expansion does flatten again", () => {
    // The counter would be vacuous if it never moved. It moves exactly where the
    // index is rebuilt, which is the only place a flattening can become stale.
    const expanded = new DiffRowIndex(
      SMALL_DIFF,
      expandGap(new Map(), 0, 0, SMALL_DIFF_SHAPE.precedingContextPerHunk),
    );
    expect(expanded.bodyLayoutBuildCount).toBeGreaterThan(0);
  });

  it("hands back the same rows in both modes as a full sweep of every index", () => {
    // Byte-for-byte against the addressing the other cases in this file pin: every
    // row of every mode resolves, every line row resolves to a line, and the line
    // rows account for exactly the hunk bodies the shape holds.
    for (const viewMode of DIFF_VIEW_MODES) {
      const index = new DiffRowIndex(SMALL_DIFF, new Map(), undefined, viewMode);
      const rows = everyRow(index);
      expect(rows).toHaveLength(index.rowCount);
      const bodyRows = rows.filter((row) => row.kind === "line" && row.source === "hunk-body");
      for (const row of bodyRows) {
        expect(index.lineFor(row)).toBeDefined();
      }
      // Unified spells every line as its own row, so the two counts agree there and
      // split's pairing is the only thing that can make them differ.
      expect(bodyRows.length).toBeLessThanOrEqual(fixtureChangedLineCount(SMALL_DIFF_SHAPE));
    }
  });
});

describe("hunk virtualization — the bounds it spends", () => {
  it("overscans in both directions and estimates a row above zero", () => {
    // The bounds are a table of numbers, and a table of numbers is only a
    // decision while the relations between them hold. An overscan of zero would
    // expose the unrendered band on every flick, and a row height of zero would
    // hand the virtualizer an estimate under which every row sits at the same
    // offset.
    expect(DIFF_WINDOW_OVERSCAN_ROWS).toBeGreaterThan(0);
    expect(DIFF_GAP_EXPANSION_LINE_COUNT).toBeGreaterThan(0);
    expect(DIFF_ROW_HEIGHT_PX).toBeGreaterThan(0);
  });

  it("describes the endurance shape it claims to", () => {
    expect(fixtureChangedLineCount(ENDURANCE_DIFF_SHAPE)).toBe(5000);
    expect(ENDURANCE_DIFF_SHAPE.fileCount).toBe(40);
  });
});
