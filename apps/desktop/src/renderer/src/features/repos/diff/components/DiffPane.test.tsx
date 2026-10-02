// The diff pane: an unasked question renders `not-checked`, never `empty`, which would assert the
// workspace has no changes; and once it holds a change set, which file and which gap a press
// reaches, and what survives the pane being reused for another diff.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildDiffFixture } from "@test/helpers/diff-fixture.js";
import { SMALL_DIFF_SHAPE } from "@test/helpers/diff-fixture-shapes.js";
import { type DiffModel } from "../diff-model.js";

import { DiffPane } from "./DiffPane.js";
import {
  DIFF_PANE_WORKSPACE_ENTITY,
  diffPaneContextFor,
  installDiffPaneLayout,
} from "./DiffPane.test-support.js";

const WORKSPACE_ENTITY = DIFF_PANE_WORKSPACE_ENTITY;

installDiffPaneLayout();

describe("diff pane — the absence it renders", () => {
  it("says the question was not put, in the pane", () => {
    const { container } = render(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} />);
    const nothing = container.querySelector(".meridian-nothing");
    expect(nothing?.classList.contains("meridian-nothing--not-checked")).toBe(true);
    expect(nothing?.classList.contains("meridian-nothing--block")).toBe(true);
  });
});

describe("diff pane — the file list and the rows", () => {
  it("narrows the rows to the file a person selects", () => {
    const { container, getByRole } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    const before = container.querySelector(".meridian-diff")?.getAttribute("aria-rowcount");
    fireEvent.click(getByRole("button", { name: /module-01\.ts/u }));
    const after = container.querySelector(".meridian-diff")?.getAttribute("aria-rowcount");
    expect(Number(after)).toBeLessThan(Number(before));
    expect(container.querySelector(".meridian-diff__row--file")?.textContent).toContain(
      "module-01.ts",
    );
  });
});

describe("diff pane — expanding a gap in a file that is not the first", () => {
  /**
   * Two files whose gaps differ in size, so a pane that resolved the wrong file's count is
   * distinguishable. Trimming the first file's context is what makes it observable.
   */
  const UNEVEN_GAP_DIFF: DiffModel = (() => {
    const whole = buildDiffFixture(SMALL_DIFF_SHAPE);
    return {
      ...whole,
      files: whole.files.map((file, fileIndex) =>
        fileIndex === 0
          ? {
              ...file,
              hunks: file.hunks.map((hunk) => ({
                ...hunk,
                precedingContext: hunk.precedingContext.slice(-1),
              })),
            }
          : file,
      ),
    };
  })();

  const gapLabelFor = (hiddenLineCount: number): string =>
    `Expand ${String(hiddenLineCount)} hidden lines`;

  it("reveals the selected file's whole gap, because it read that file's count", () => {
    const { container, getAllByRole, getByRole } = render(
      <DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} diff={UNEVEN_GAP_DIFF} />,
    );
    fireEvent.click(getByRole("button", { name: /module-01\.ts/u }));
    // The label is the second file's own count, not the first file's.
    const gaps = getAllByRole("button", {
      name: gapLabelFor(SMALL_DIFF_SHAPE.precedingContextPerHunk),
    });
    expect(gaps).toHaveLength(SMALL_DIFF_SHAPE.hunksPerFile);
    fireEvent.click(gaps[0]!);
    // One activation reveals a whole four-line gap; the first file's single line would leave
    // three hidden and both gap rows in place.
    expect(container.querySelectorAll(".meridian-diff__row--gap")).toHaveLength(
      SMALL_DIFF_SHAPE.hunksPerFile - 1,
    );
  });
});

describe("diff pane — reused for a different diff", () => {
  /** A change set whose files share no path with the fixture's. */
  const OTHER_DIFF: DiffModel = (() => {
    const whole = buildDiffFixture(SMALL_DIFF_SHAPE);
    return {
      ...whole,
      files: whole.files.map((file) => ({ ...file, path: `other/${file.path}` })),
    };
  })();

  it("drops a selection the new diff does not contain, instead of reporting no changes", () => {
    // A path absent from the new model narrows the index to no file, so `rowCount` is zero and
    // the renderer would state that two states are identical over a change set with changes.
    const { container, getByRole, rerender } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    fireEvent.click(getByRole("button", { name: /module-01\.ts/u }));
    rerender(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} diff={OTHER_DIFF} />);
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(container.querySelectorAll(".meridian-diff__row").length).toBeGreaterThan(0);
    // The file list opens on the whole change set again, not on a path the new diff lacks.
    expect(
      container.querySelector('.meridian-diff-files__entry[aria-current="true"]')?.textContent,
    ).toContain("All files");
  });

  it("drops the previous diff's gap expansion rather than inheriting it by index", () => {
    // The expansion is keyed by file and hunk index; those exist in the new diff too and
    // address different hunks, so an inherited expansion opens somebody else's gaps.
    const { container, getAllByRole, rerender } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    const gapCountBefore = container.querySelectorAll(".meridian-diff__row--gap").length;
    fireEvent.click(getAllByRole("button", { name: /Expand \d+ hidden lines/u })[0]!);
    expect(container.querySelectorAll(".meridian-diff__row--gap").length).toBeLessThan(
      gapCountBefore,
    );

    rerender(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} diff={OTHER_DIFF} />);
    expect(container.querySelectorAll(".meridian-diff__row--gap").length).toBe(gapCountBefore);
  });
});

describe("diff pane — the toolbar", () => {
  it("switches the renderer between unified and split", () => {
    const { container, getByRole } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    expect(container.querySelectorAll(".meridian-diff__side--base").length).toBe(0);
    fireEvent.click(getByRole("button", { name: "Unified view" }));
    expect(container.querySelectorAll(".meridian-diff__side--base").length).toBeGreaterThan(0);
  });
});
