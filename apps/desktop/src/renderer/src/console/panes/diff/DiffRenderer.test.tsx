// The renderer's claims, and the two it would be worst to get wrong.
//
// The ordinary ones are that the rows arrive, that both layouts draw what each
// layout should, and that a long line is never clipped. The two that matter more
// are the ones a reviewer cannot see by looking at a screenshot: that the row
// count on screen is bounded by the WINDOW and not by the diff, which is the only
// reason a five-thousand-line change set is openable at all; and that no line
// kind is painted amber or red, which is the two-hue rule and is exactly the rule
// a diff renderer is most likely to break.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ENDURANCE_DIFF_SHAPE, SMALL_DIFF_SHAPE, buildDiffFixture } from "./diff-fixture.js";
import { DiffRenderer } from "./DiffRenderer.js";
import { expandGap, type DiffGapExpansion } from "./hunk-virtualization.js";

const SMALL_DIFF = buildDiffFixture(SMALL_DIFF_SHAPE);
const NO_EXPANSION: DiffGapExpansion = new Map();

function renderDiff(
  overrides: Partial<React.ComponentProps<typeof DiffRenderer>> = {},
): HTMLElement {
  const { container } = render(
    <DiffRenderer
      model={SMALL_DIFF}
      viewMode="unified"
      showAttributionMarks
      wrapLongLines={false}
      showWhitespaceChanges
      expansion={NO_EXPANSION}
      onExpandGap={() => undefined}
      label="Diff, main to feat/rate-limit-wiring"
      {...overrides}
    />,
  );
  return container;
}

describe("diff renderer — the rows", () => {
  it("names itself as a table and reports the whole diff's row count", () => {
    const container = renderDiff();
    const scroller = container.querySelector(".meridian-diff");
    expect(scroller?.getAttribute("aria-label")).toBe("Diff, main to feat/rate-limit-wiring");
    // The count is the DIFF's, not the window's — a virtualized list that
    // reported its rendered count would tell a screen reader the diff is
    // fifteen rows long.
    expect(scroller?.getAttribute("aria-rowcount")).toBe("22");
  });

  it("draws the file header, the gap, the hunk header, and the lines", () => {
    const container = renderDiff();
    expect(container.querySelector(".meridian-diff__row--file")?.textContent).toContain(
      "packages/runtime-daemon/src/module-00.ts",
    );
    expect(container.querySelector(".meridian-diff__row--gap")?.textContent).toContain(
      "Expand 4 hidden lines",
    );
    expect(container.querySelector(".meridian-diff__row--hunk")?.textContent).toContain("@@ -1,3");
    expect(container.querySelectorAll(".meridian-diff__row--line").length).toBeGreaterThan(0);
  });

  it("renders only a window of a five-thousand-line change set", () => {
    // The claim the whole module exists for. A renderer that drew every row would
    // pass every other case in this file and cost about 6,600 DOM rows here.
    const bigDiff = buildDiffFixture(ENDURANCE_DIFF_SHAPE);
    const container = renderDiff({ model: bigDiff });
    const renderedRowCount = container.querySelectorAll(".meridian-diff__row").length;
    expect(renderedRowCount).toBeGreaterThan(0);
    expect(renderedRowCount).toBeLessThan(100);
  });

  it("negative control: the big diff really is big, so the bound above is not vacuous", () => {
    const bigDiff = buildDiffFixture(ENDURANCE_DIFF_SHAPE);
    const container = renderDiff({ model: bigDiff });
    const reported = container.querySelector(".meridian-diff")?.getAttribute("aria-rowcount");
    expect(Number(reported)).toBeGreaterThan(5000);
  });
});

describe("diff renderer — the two-hue rule", () => {
  it("paints insert and delete with ground and rule, never with a hue token", () => {
    const container = renderDiff();
    const insertRow = container.querySelector(".meridian-diff__row--insert");
    const deleteRow = container.querySelector(".meridian-diff__row--delete");
    expect(insertRow).not.toBeNull();
    expect(deleteRow).not.toBeNull();
    // The classes are the whole signal, and they are distinct — which is what the
    // sheet then paints as two ground weights and two rule styles.
    expect(insertRow?.className).not.toBe(deleteRow?.className);
  });

  it("negative control: no diff row reaches for amber or red", () => {
    // Amber means a person is needed and red means something failed. A deleted
    // line is neither, and this is the case that fails the day somebody reaches
    // for the familiar colours.
    const container = renderDiff();
    for (const row of container.querySelectorAll(".meridian-diff__row")) {
      expect(row.className).not.toContain("amber");
      expect(row.className).not.toContain("failure");
      expect(row.className).not.toContain("--red");
    }
  });
});

describe("diff renderer — the view controls it is handed", () => {
  it("renders two sides in split view and one in unified", () => {
    expect(
      renderDiff({ viewMode: "split" }).querySelectorAll(".meridian-diff__side--base").length,
    ).toBeGreaterThan(0);
    expect(
      renderDiff({ viewMode: "unified" }).querySelectorAll(".meridian-diff__side--base").length,
    ).toBe(0);
  });

  it("marks the intraline change, and stops marking a whitespace-only one on request", () => {
    const whitespaceOnlyDiff = {
      ...SMALL_DIFF,
      files: [
        {
          path: "packages/contracts/src/spacing.ts",
          hunks: [
            {
              header: "@@ -1,1 +1,1 @@",
              precedingContext: [],
              lines: [
                {
                  kind: "insert" as const,
                  headLineNumber: 1,
                  segments: [
                    { text: "value", changed: false },
                    { text: "   ", changed: true },
                    { text: "= 1;", changed: false },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const shown = renderDiff({ model: whitespaceOnlyDiff, showWhitespaceChanges: true });
    expect(shown.querySelectorAll(".meridian-diff__segment--changed").length).toBe(1);
    const hidden = renderDiff({ model: whitespaceOnlyDiff, showWhitespaceChanges: false });
    expect(hidden.querySelectorAll(".meridian-diff__segment--changed").length).toBe(0);
    // The characters are still there — the toggle withholds emphasis and never
    // shortens the line.
    expect(hidden.querySelector(".meridian-diff__code")?.textContent).toBe("value   = 1;");
  });

  it("shows an attribution mark only where the trailers named somebody, and only when asked", () => {
    const withMarks = renderDiff({ showAttributionMarks: true });
    const withoutMarks = renderDiff({ showAttributionMarks: false });
    expect(withMarks.querySelectorAll(".meridian-diff__attribution-mark").length).toBeGreaterThan(
      0,
    );
    expect(withoutMarks.querySelectorAll(".meridian-diff__attribution-mark").length).toBe(0);
  });

  it("negative control: attribution comes from the line and never from the diff's own run", () => {
    // Every line here carries no trailer, so a renderer that fell back to the
    // diff's run would mark all of them — the inference `Spec-011` forbids.
    const unattributed = buildDiffFixture({
      ...SMALL_DIFF_SHAPE,
      agentAttributionEveryNthLine: 0,
    });
    const container = renderDiff({ model: unattributed, showAttributionMarks: true });
    expect(container.querySelectorAll(".meridian-diff__attribution-mark").length).toBe(0);
  });

  it("carries the wrap toggle onto the scroller", () => {
    expect(
      renderDiff({ wrapLongLines: true }).querySelector(".meridian-diff--wrap"),
    ).not.toBeNull();
    expect(renderDiff({ wrapLongLines: false }).querySelector(".meridian-diff--wrap")).toBeNull();
  });
});

describe("diff renderer — expansion and emptiness", () => {
  it("replaces the expanded gap with its context, leaving the diff's other gaps alone", () => {
    // Positional rather than counted: expansion acts on ONE gap, and the row
    // immediately after the first file header is where that shows. A count would
    // also move because the window's rows shift under the newly revealed lines,
    // which would make the case pass for the wrong reason.
    const rowClassesAfterFirstFileHeader = (container: HTMLElement): string =>
      container.querySelectorAll(".meridian-diff__row")[1]?.className ?? "";

    expect(rowClassesAfterFirstFileHeader(renderDiff())).toContain("meridian-diff__row--gap");

    const expanded = renderDiff({
      expansion: expandGap(new Map(), 0, 0, SMALL_DIFF_SHAPE.precedingContextPerHunk),
    });
    expect(rowClassesAfterFirstFileHeader(expanded)).toContain("meridian-diff__row--context");
    // The diff's OTHER gaps are untouched: one control, one gap.
    expect(expanded.querySelectorAll(".meridian-diff__row--gap").length).toBeGreaterThan(0);
  });

  it("says two identical states are identical, which is a read that returned nothing", () => {
    // `empty` and not `not-checked`: a diff WAS read here, and it holds no changed
    // line. The pane spends `not-checked` for the other fact.
    const container = renderDiff({ model: { ...SMALL_DIFF, files: [] } });
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });
});
