// The model's two claims: a diff's attribution names exactly one subject, and a
// file's change counts come from the hunks and not from what a reader expanded.

import { describe, expect, it } from "vitest";

import { buildDiffFixture } from "./diff-fixture.test-support.js";
import {
  RUN_ATTRIBUTION,
  SMALL_DIFF_SHAPE,
  WORKSPACE_FALLBACK_ATTRIBUTION,
} from "./diff-fixture-shapes.test-support.js";
import {
  DIFF_ATTRIBUTION_MODES,
  DIFF_LINE_KINDS,
  DIFF_VIEW_MODES,
  diffAttributionSubjectId,
  diffFileChangeCounts,
  diffLineText,
} from "./diff-model.js";
import { intralineSegments } from "./patch-parse.js";

describe("diff model — the closed sets", () => {
  it("declares two attribution modes, three line kinds, and two view modes", () => {
    // Counts rather than membership, because each of these is a claim a spec
    // makes about how many answers exist, and a fourth line kind added without a
    // renderer branch is the failure this catches.
    expect([...DIFF_ATTRIBUTION_MODES]).toStrictEqual(["run_attributed", "workspace_fallback"]);
    expect(DIFF_LINE_KINDS).toHaveLength(3);
    expect(DIFF_VIEW_MODES).toHaveLength(2);
  });
});

describe("diff model — attribution", () => {
  it("names the run on the run-attributed arm and the workspace on the other", () => {
    expect(diffAttributionSubjectId(RUN_ATTRIBUTION)).toBe("run-rate-limit-wiring");
    expect(diffAttributionSubjectId(WORKSPACE_FALLBACK_ATTRIBUTION)).toBe("workspace-sidekicks");
  });

  it("negative control: the workspace arm carries no run to read", () => {
    // The claim `Spec-011 §Pitfalls To Avoid` names — never pretend a workspace
    // diff is run-attributed — is enforced by the union's shape rather than by a
    // renderer's discipline, and this is what says so at runtime.
    expect(Object.hasOwn(WORKSPACE_FALLBACK_ATTRIBUTION, "runId")).toBe(false);
    expect(Object.hasOwn(RUN_ATTRIBUTION, "workspaceId")).toBe(false);
  });
});

describe("diff model — derived figures", () => {
  it("counts a file's insertions and deletions from its hunk bodies", () => {
    const file = buildDiffFixture(SMALL_DIFF_SHAPE).files[0];
    expect(file).toBeDefined();
    const counts = diffFileChangeCounts(file!);
    // The fixture cycles context / insert / delete, so three lines per hunk is
    // one of each, twice over.
    expect(counts).toStrictEqual({ insertions: 2, deletions: 2 });
  });

  it("negative control: hidden context never counts as a change", () => {
    // Without this, a counter that walked `precedingContext` too would report a
    // file's totals differently depending on how much of its gaps a reader had
    // expanded — a figure that changes when nobody changed anything.
    const withMoreContext = buildDiffFixture({
      ...SMALL_DIFF_SHAPE,
      precedingContextPerHunk: SMALL_DIFF_SHAPE.precedingContextPerHunk * 10,
    });
    const file = withMoreContext.files[0];
    expect(file).toBeDefined();
    expect(diffFileChangeCounts(file!)).toStrictEqual({ insertions: 2, deletions: 2 });
  });

  it("reassembles a line from its segments, changed runs included", () => {
    const lines = buildDiffFixture(SMALL_DIFF_SHAPE).files[0]?.hunks[0]?.lines;
    const deletedLine = lines?.[1];
    const insertedLine = lines?.[2];
    expect(deletedLine).toBeDefined();
    expect(insertedLine).toBeDefined();
    // A PARSED line carries one whole-line segment; the multi-segment shape this
    // function has to survive is the derived intraline reading. So the subject is
    // built through the seam that produces it rather than typed out by hand, which
    // would assert reassembly over a shape nothing makes.
    const segmented = {
      ...deletedLine!,
      segments: intralineSegments(diffLineText(deletedLine!), diffLineText(insertedLine!)).deleted,
    };
    expect(segmented.segments.length).toBeGreaterThan(1);
    expect(diffLineText(segmented)).toBe(diffLineText(deletedLine!));
  });
});
