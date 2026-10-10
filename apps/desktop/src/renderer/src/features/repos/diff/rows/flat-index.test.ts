// The flattening the diff views rest on. Every case runs without a DOM, which is what lets
// `flat-index.large.test.ts` measure a five-thousand-line change set; the window itself
// comes from `@tanstack/react-virtual` and is asserted against the DOM in `DiffRenderer.test.ts`.

import { describe, expect, it } from "vitest";
import { buildDiffFixture } from "#test/helpers/diff/fixture/model.js";
import { SMALL_DIFF_SHAPE } from "#test/helpers/diff/fixture/shapes.js";
import { DIFF_VIEW_MODES, type DiffModel } from "../model.js";
import { type DiffRow } from "./model.js";
import { DiffRowIndex } from "./flat-index.js";

const SMALL_DIFF = buildDiffFixture(SMALL_DIFF_SHAPE);

/**
 * The row count the shape implies, derived from the shape rather than counted off the code
 * under test: per file one header, then per hunk a gap row (while anything is hidden), the
 * revealed context, the hunk header and the hunk's own lines.
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

  it("finds the second file's header at the row that file starts on", () => {
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

  it("resolves an index past the end to nothing", () => {
    // `rowAt` must not answer the last row for every index past the end.
    const index = new DiffRowIndex(SMALL_DIFF);
    expect(index.rowAt(index.rowCount)).toBeUndefined();
    expect(index.rowAt(-1)).toBeUndefined();
  });
});

describe("hunk virtualization — narrowing to one file", () => {
  const secondFilePath = SMALL_DIFF.files[1]?.path ?? "";

  it("keeps the model's own file index on every row it hands out", () => {
    // A renumbered index would call the shown file zero, and the host would resolve the first
    // file's gap context.
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
    // A row's `fileIndex` addresses the model, so it is not narrowed with the rows.
    expect(narrowed.model.files).toHaveLength(SMALL_DIFF_SHAPE.fileCount);
    expect(narrowed.rowIndexOfFile(1)).toBe(0);
    expect(narrowed.rowIndexOfFile(0)).toBeUndefined();
  });
});

describe("hunk virtualization — pairing a modified line in split view", () => {
  /** A one-file, one-hunk diff whose body is exactly the kinds a case names. */
  function diffWithHunkBody(kinds: readonly ("context" | "insert" | "delete")[]): DiffModel {
    return {
      ...SMALL_DIFF,
      files: [
        {
          path: "packages/contracts/src/budget.ts",
          change: { kind: "modified" },
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
    // The count and the addressing come from one walk: a second implementation of the count
    // would agree on even shapes and misplace every row below the first uneven one.
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
});

describe("hunk virtualization — a hunk is flattened once, not once per lookup", () => {
  it("builds nothing further however many rows are read from it", () => {
    // `rowAt` must not re-flatten every hunk it walks past, or a scroll would cost the change
    // set rather than the viewport.
    const index = new DiffRowIndex(SMALL_DIFF);
    const afterConstruction = index.bodyLayoutBuildCount;
    for (let pass = 0; pass < 3; pass += 1) {
      for (let rowIndex = 0; rowIndex < index.rowCount; rowIndex += 1) {
        expect(index.rowAt(rowIndex)).toBeDefined();
      }
    }
    expect(index.bodyLayoutBuildCount).toBe(afterConstruction);
  });
});
