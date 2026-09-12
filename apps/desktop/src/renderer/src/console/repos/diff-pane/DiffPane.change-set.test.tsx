// The diff pane once it holds a change set.
//
// SPLIT FROM `DiffPane.test.tsx` ON THE PANE'S OWN SEAM. That file is about a pane
// holding no model — the chrome it wears, the create it offers over the two subjects
// the wire can be keyed by, and the absence it owes the other three. What follows is
// the surface `DiffPane.tsx` describes once a model exists: the compared states and the
// attribution badge, the changed-file list and the rows, what survives the pane being
// reused for a different diff, and the toolbar. The two halves mount the same pane and
// share nothing else, which is why the contexts and the layout discipline they do share
// live in `diff-pane.test-support.ts` rather than in either of them.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildDiffFixture } from "./diff-fixture.test-support.js";
import {
  RUN_ATTRIBUTED_ATTRIBUTION,
  SMALL_DIFF_SHAPE,
  WORKSPACE_FALLBACK_ATTRIBUTION,
} from "./diff-fixture-shapes.test-support.js";
import { type ConsoleDiffModel } from "./diff-model.js";

import { DiffPane } from "./DiffPane.js";
import {
  DIFF_PANE_WORKSPACE_ENTITY,
  diffPaneContextFor,
  installDiffPaneLayout,
} from "./diff-pane.test-support.js";

const WORKSPACE_ENTITY = DIFF_PANE_WORKSPACE_ENTITY;

installDiffPaneLayout();

describe("diff pane — the header a diff gives it", () => {
  it("names the compared states and the attribution mode", () => {
    const { container } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    const subjectBar = container.querySelector(".meridian-diff-pane__subject-bar");
    expect(subjectBar?.textContent).toContain("Run-attributed");
    expect(subjectBar?.textContent).toContain("main");
    expect(subjectBar?.textContent).toContain("feat/rate-limit-wiring");
  });

  it("renders a workspace-fallback diff's workspace, and no run anywhere", () => {
    // Pretending a workspace diff is run-attributed is the pitfall here. The union
    // makes the wrong shape unrepresentable; this is
    // the check that the renderer did not reintroduce it by reaching elsewhere.
    const fallbackDiff = buildDiffFixture(SMALL_DIFF_SHAPE, WORKSPACE_FALLBACK_ATTRIBUTION);
    const { container } = render(
      <DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} diff={fallbackDiff} />,
    );
    const subjectBar = container.querySelector(".meridian-diff-pane__subject-bar");
    expect(subjectBar?.textContent).toContain("Workspace fallback");
    expect(subjectBar?.textContent).toContain("workspace-sidekicks");
    expect(subjectBar?.textContent).not.toContain("run-");
  });

  it("negative control: the badge is neutral on both arms, so neither spends a hue", () => {
    // A workspace fallback is a lower attribution quality — not a failure and not
    // something a person must act on. Amber or red here would be the two-hue rule
    // broken in the one place it is tempting.
    for (const attribution of [RUN_ATTRIBUTED_ATTRIBUTION, WORKSPACE_FALLBACK_ATTRIBUTION]) {
      const { container } = render(
        <DiffPane
          context={diffPaneContextFor(WORKSPACE_ENTITY)}
          diff={buildDiffFixture(SMALL_DIFF_SHAPE, attribution)}
        />,
      );
      const chips = container.querySelectorAll(".meridian-diff-pane__subject-bar .meridian-chip");
      expect(chips.length).toBeGreaterThan(0);
      for (const chip of chips) {
        expect(chip.className).not.toContain("attention");
        expect(chip.className).not.toContain("failure");
      }
    }
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
   * Two files whose gaps differ in size.
   *
   * The generated shape gives every file the same hidden-line count, and a pane
   * that resolved the wrong file's count would be indistinguishable from one that
   * resolved the right file's. Trimming the FIRST file's context is what makes the
   * difference observable, because the first file is the one a renumbered index
   * would have reached for.
   */
  const UNEVEN_GAP_DIFF: ConsoleDiffModel = (() => {
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

  /** How the gap row labels the context it still hides. One writer, one reader. */
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
    // One activation reveals a whole four-line gap, so that hunk's gap row is
    // gone and only the file's other hunk still has one. Had the FIRST file's
    // single line been used, three would still be hidden and both would remain.
    expect(container.querySelectorAll(".meridian-diff__row--gap")).toHaveLength(
      SMALL_DIFF_SHAPE.hunksPerFile - 1,
    );
  });

  it("negative control: the first file's gap really is the smaller one", () => {
    // Without this the case above would pass over a fixture whose two files were
    // identical, which is the shape the defect is invisible in.
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
  const OTHER_DIFF: ConsoleDiffModel = (() => {
    const whole = buildDiffFixture(SMALL_DIFF_SHAPE);
    return {
      ...whole,
      files: whole.files.map((file) => ({ ...file, path: `other/${file.path}` })),
    };
  })();

  it("drops a selection the new diff does not contain, instead of reporting no changes", () => {
    // The defect this whole block exists for. A path absent from the new model
    // narrows the index to no file, `rowCount` is zero, and the renderer states
    // that two states are identical over a change set that has changes.
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
    // And the file list opens on the whole change set again, not on a path that
    // is no longer in it.
    expect(
      container.querySelector('.meridian-diff-files__entry[aria-current="true"]')?.textContent,
    ).toContain("All files");
  });

  it("drops the previous diff's gap expansion rather than inheriting it by index", () => {
    // The expansion is keyed by `(fileIndex, hunkIndex)`. Those indices exist in
    // the new diff too and address different hunks, so an inherited expansion
    // opens somebody else's gaps.
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
    // Without this, the two cases above would pass over a pane that reset its
    // view state on every render — which would take the selection away the
    // instant anything else in the console moved.
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

  it("keeps the toolbar's reading preferences across a model change", () => {
    // View mode, wrap, whitespace and attribution marks are preferences over the
    // PANE. Resetting them with the model would undo a person's toggle every time
    // the subject moved.
    const { container, getByRole, rerender } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Wrap long lines" }));
    expect(container.querySelector(".meridian-diff--wrap")).not.toBeNull();
    rerender(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} diff={OTHER_DIFF} />);
    expect(container.querySelector(".meridian-diff--wrap")).not.toBeNull();
  });
});

describe("diff pane — the toolbar", () => {
  it("offers the four renderer-local controls, with marks on by default", () => {
    // `DiffToolbar.tsx`'s density rule: attribution marks are ON in the pane and OFF
    // in the card, one toggle away in both.
    const { getByRole } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    expect(getByRole("toolbar", { name: "Diff view controls" })).toBeDefined();
    expect(getByRole("button", { name: "Attribution marks" }).getAttribute("aria-pressed")).toBe(
      "true",
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
    // Without this, a toolbar whose values nothing read would pass every
    // `aria-pressed` assertion above while changing nothing on screen.
    const { container, getByRole } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    expect(container.querySelector(".meridian-diff--wrap")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Wrap long lines" }));
    expect(container.querySelector(".meridian-diff--wrap")).not.toBeNull();
  });
});
