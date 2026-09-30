// The diff pane once it holds a change set: compared states, changed-file list, rows, what
// survives the pane being reused for another diff, and the toolbar. Split from `DiffPane.test.tsx`;
// the shared contexts and layout live in `diff-pane.test-support.ts`.

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
} from "./diff-pane.test-support.js";

const WORKSPACE_ENTITY = DIFF_PANE_WORKSPACE_ENTITY;

installDiffPaneLayout();

describe("diff pane — the compared states", () => {
  it("names the compared states on the rows' accessible name", () => {
    const { getByRole } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    expect(getByRole("table", { name: "Diff, main to feat/rate-limit-wiring" })).toBeDefined();
  });
});

describe("diff pane — the file list and the rows", () => {
  it("opens on the changed-file list with the rows beside it", () => {
    const { container } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    expect(container.querySelectorAll(".meridian-diff-files__entry").length).toBe(
      SMALL_DIFF_SHAPE.fileCount + 1,
    );
    expect(container.querySelector(".meridian-diff")).not.toBeNull();
  });

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

  it("filters the list, and says so when nothing matches", () => {
    const { container, getByRole } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    fireEvent.change(getByRole("searchbox"), { target: { value: "module-01" } });
    // The "All files" entry always stands, so one match leaves two entries.
    expect(container.querySelectorAll(".meridian-diff-files__entry").length).toBe(2);
    fireEvent.change(getByRole("searchbox"), { target: { value: "no-such-path" } });
    expect(container.querySelector(".meridian-diff-files__no-match")).not.toBeNull();
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

  it("negative control: the first file's gap really is the smaller one", () => {
    // Negative control: two identical files would pass the case above.
    const { getAllByRole, getByRole } = render(
      <DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} diff={UNEVEN_GAP_DIFF} />,
    );
    fireEvent.click(getByRole("button", { name: /module-00\.ts/u }));
    expect(getAllByRole("button", { name: gapLabelFor(1) })).toHaveLength(
      SMALL_DIFF_SHAPE.hunksPerFile,
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

  it("negative control: the SAME model object keeps the selection and the expansion", () => {
    // Negative control: a pane that reset its view state on every render would pass above and
    // drop the selection whenever anything else in the console moved.
    const sameDiff = buildDiffFixture(SMALL_DIFF_SHAPE);
    const { container, getAllByRole, getByRole, rerender } = render(
      <DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} diff={sameDiff} />,
    );
    fireEvent.click(getByRole("button", { name: /module-01\.ts/u }));
    fireEvent.click(getAllByRole("button", { name: /Expand \d+ hidden lines/u })[0]!);
    const gapCountAfterExpanding = container.querySelectorAll(".meridian-diff__row--gap").length;

    rerender(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} diff={sameDiff} />);
    expect(container.querySelector(".meridian-diff__row--file")?.textContent).toContain(
      "module-01.ts",
    );
    expect(container.querySelectorAll(".meridian-diff__row--gap").length).toBe(
      gapCountAfterExpanding,
    );
  });

  it("keeps the toolbar's reading preference across a model change", () => {
    // View mode is a preference over the PANE. Resetting it with the model would undo a
    // person's toggle every time the subject moved.
    const { container, getByRole, rerender } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Unified view" }));
    expect(container.querySelector(".meridian-diff--split")).not.toBeNull();
    rerender(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} diff={OTHER_DIFF} />);
    expect(container.querySelector(".meridian-diff--split")).not.toBeNull();
  });
});

describe("diff pane — the toolbar", () => {
  it("offers the view control, unified by default", () => {
    const { getByRole } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    expect(getByRole("toolbar", { name: "Diff view controls" })).toBeDefined();
    expect(getByRole("button", { name: "Unified view" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

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

  it("negative control: a toggle actually moves the renderer, not just its own state", () => {
    // Negative control: a toolbar whose values nothing read would pass every `aria-pressed`
    // assertion above.
    const { container, getByRole } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    expect(container.querySelector(".meridian-diff--split")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Unified view" }));
    expect(container.querySelector(".meridian-diff--split")).not.toBeNull();
  });
});
