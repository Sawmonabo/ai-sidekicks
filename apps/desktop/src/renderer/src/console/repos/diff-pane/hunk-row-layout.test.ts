// What one hunk body's flattening is, in each of its two forms.

import { describe, expect, it } from "vitest";

import type { DiffLine, DiffLineKind } from "./diff-model.js";
import { wholeLineSegments } from "./patch-parse.js";
import { buildHunkBodyLayout, hunkBodyRowAt, hunkBodyRowCount } from "./hunk-row-layout.js";

function line(kind: DiffLineKind, text: string): DiffLine {
  return { kind, segments: wholeLineSegments(text) };
}

/** A modified line pair between two context lines: the shape the two modes disagree on. */
const MODIFIED_PAIR: readonly DiffLine[] = [
  line("context", "before"),
  line("delete", "was"),
  line("insert", "is"),
  line("context", "after"),
];

describe("hunk body layout — unified is the identity, and holds no array", () => {
  it("reports one row per line without materialising them", () => {
    const layout = buildHunkBodyLayout(MODIFIED_PAIR, "unified");
    expect(layout.kind).toBe("identity");
    expect(hunkBodyRowCount(layout)).toBe(MODIFIED_PAIR.length);
  });

  it("answers each row arithmetically, and nothing past the end", () => {
    const layout = buildHunkBodyLayout(MODIFIED_PAIR, "unified");
    expect(hunkBodyRowAt(layout, 0)).toStrictEqual({ lineIndex: 0 });
    expect(hunkBodyRowAt(layout, 3)).toStrictEqual({ lineIndex: 3 });
    expect(hunkBodyRowAt(layout, 4)).toBeUndefined();
    expect(hunkBodyRowAt(layout, -1)).toBeUndefined();
  });

  it("holds nothing per line, whatever the hunk's size", () => {
    // The allocation the finding is about: a five-thousand-line hunk in unified mode
    // used to become five thousand objects describing an arithmetic sequence.
    const wide = Array.from({ length: 5_000 }, (_unused, index) =>
      line("context", `line ${String(index)}`),
    );
    const layout = buildHunkBodyLayout(wide, "unified");
    expect(layout).toStrictEqual({ kind: "identity", rowCount: 5_000 });
  });
});

describe("hunk body layout — split pairs positionally, and holds the pairing", () => {
  it("pairs a deletion with the insertion that follows it into one row", () => {
    const layout = buildHunkBodyLayout(MODIFIED_PAIR, "split");
    expect(layout.kind).toBe("paired");
    expect(hunkBodyRowCount(layout)).toBe(3);
    expect(hunkBodyRowAt(layout, 1)).toStrictEqual({ lineIndex: 1, pairedLineIndex: 2 });
  });

  it("leaves the longer run's overhang unpaired, one row per line", () => {
    const layout = buildHunkBodyLayout(
      [line("delete", "one"), line("delete", "two"), line("insert", "only")],
      "split",
    );
    expect(hunkBodyRowCount(layout)).toBe(2);
    expect(hunkBodyRowAt(layout, 0)).toStrictEqual({ lineIndex: 0, pairedLineIndex: 2 });
    expect(hunkBodyRowAt(layout, 1)).toStrictEqual({ lineIndex: 1 });
  });

  it("negative control: the two modes really do flatten this shape differently", () => {
    expect(hunkBodyRowCount(buildHunkBodyLayout(MODIFIED_PAIR, "unified"))).not.toBe(
      hunkBodyRowCount(buildHunkBodyLayout(MODIFIED_PAIR, "split")),
    );
  });
});
