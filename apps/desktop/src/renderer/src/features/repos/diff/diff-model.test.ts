// The model's derived figures: a file's change counts, and a line reassembled from its
// segments.

import { describe, expect, it } from "vitest";

import { buildDiffFixture } from "@test/helpers/diff-fixture.js";
import { SMALL_DIFF_SHAPE } from "@test/helpers/diff-fixture-shapes.js";
import { diffFileChangeCounts, diffLineText } from "./diff-model.js";
import { intralineSegments } from "./patch-parse.js";

describe("diff model — derived figures", () => {
  it("counts a file's insertions and deletions from its hunk bodies", () => {
    const file = buildDiffFixture(SMALL_DIFF_SHAPE).files[0];
    expect(file).toBeDefined();
    const counts = diffFileChangeCounts(file!);
    // The fixture cycles context / insert / delete, so three lines per hunk is
    // one of each, twice over.
    expect(counts).toStrictEqual({ insertions: 2, deletions: 2 });
  });

  it("reassembles a line from its segments, changed runs included", () => {
    const lines = buildDiffFixture(SMALL_DIFF_SHAPE).files[0]?.hunks[0]?.lines;
    const deletedLine = lines?.[1];
    const insertedLine = lines?.[2];
    expect(deletedLine).toBeDefined();
    expect(insertedLine).toBeDefined();
    // A parsed line carries one whole-line segment, so the multi-segment subject is built
    // through the intraline reading that produces it.
    const segmented = {
      ...deletedLine!,
      segments: intralineSegments(diffLineText(deletedLine!), diffLineText(insertedLine!)).deleted,
    };
    expect(segmented.segments.length).toBeGreaterThan(1);
    expect(diffLineText(segmented)).toBe(diffLineText(deletedLine!));
  });
});
