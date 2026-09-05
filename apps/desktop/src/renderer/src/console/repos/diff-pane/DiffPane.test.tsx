// The diff pane's chrome, and the one thing it must not say.
//
// Two claims are worth a test here and the second is the reason the file exists.
// The first is ordinary: the pane names itself, and the entity it is a view of
// arrives on screen wire-verbatim with the full string recoverable. The second is
// what `Spec-023 §Meridian, the design language` rule 8 turns on — that an unasked
// question renders as
// `not-checked` and never as `empty`, because `empty` is the console asserting that
// a workspace has no changes. A pane that regressed into `empty` would look
// identical to a reviewer and would be stating a fact nobody established.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDiffFixture } from "./diff-fixture.js";
import {
  RUN_ATTRIBUTION,
  SMALL_DIFF_SHAPE,
  WORKSPACE_FALLBACK_ATTRIBUTION,
} from "./diff-fixture-shapes.js";
import {
  DIFF_FIXTURE_VIEWPORT_HEIGHT_PX,
  DiffLayoutFixture,
} from "./diff-layout-fixture.test-support.js";
import { type ConsoleDiffModel } from "./diff-model.js";

import { DiffPane, type DiffPaneProps } from "./DiffPane.js";

/** This pane's own address arm, taken from the prop rather than restated. */
type DiffPaneContext = DiffPaneProps["context"];

/**
 * A pane context whose collaborators are never reached.
 *
 * The cast is `legacy-surfaces.test.ts`'s: these cases are about what the chrome
 * renders from the address, and a real bridge, store pair, and persistence stack
 * would be four constructions none of the assertions below can observe. The ADDRESS
 * half is not cast — the entity parameter is the arm's own, so a case handing this
 * pane a subject a diff is never opened over fails to compile here.
 */
function contextFor(entity: DiffPaneContext["entity"]): DiffPaneContext {
  return { kind: "diff", entity, paneId: "pane-diff-1" } as unknown as DiffPaneContext;
}

const WORKSPACE_ENTITY = { kind: "workspace", id: "workspace-sidekicks" } as const;
const REPO_ENTITY = { kind: "repo", id: "repo-sidekicks" } as const;

// The rows are virtualized, so a case that reads one has to say how tall the pane
// is: happy-dom lays nothing out, and a scroller with no height correctly holds
// no rows.
const layout = new DiffLayoutFixture();

beforeEach(() => {
  layout.install({ viewportHeightPx: DIFF_FIXTURE_VIEWPORT_HEIGHT_PX });
});

afterEach(() => {
  layout.restore();
});

describe("diff pane — chrome", () => {
  it("names itself as a region", () => {
    const { getByRole } = render(<DiffPane context={contextFor(WORKSPACE_ENTITY)} />);
    expect(getByRole("region", { name: "Diff" })).toBeDefined();
  });

  it("renders the subject verbatim, with the full string recoverable", () => {
    const { container } = render(<DiffPane context={contextFor(WORKSPACE_ENTITY)} />);
    const subject = container.querySelector(".meridian-repos-pane__subject");
    expect(subject?.textContent).toBe(WORKSPACE_ENTITY.id);
    // The measure may truncate the display copy; the title is what keeps two ids
    // that differ only in their tail from reading identically with no way back.
    expect(subject?.getAttribute("title")).toBe(WORKSPACE_ENTITY.id);
  });

  it("negative control: the subject is read from the address, not fixed", () => {
    // Without this, the case above would pass over a chrome that rendered a constant.
    // A diff address always carries its entity — the arm has no shape in which it is
    // absent — so the honest control is a second subject rather than none.
    const { container } = render(<DiffPane context={contextFor(REPO_ENTITY)} />);
    const subject = container.querySelector(".meridian-repos-pane__subject");
    expect(subject?.textContent).toBe(REPO_ENTITY.id);
    expect(subject?.getAttribute("aria-label")).toBe(`Subject: repo ${REPO_ENTITY.id}`);
  });
});

describe("diff pane — the absence it renders", () => {
  it("says the question was not put, on a surface", () => {
    const { container } = render(<DiffPane context={contextFor(WORKSPACE_ENTITY)} />);
    const nothing = container.querySelector(".meridian-nothing");
    expect(nothing?.classList.contains("meridian-nothing--not-checked")).toBe(true);
    expect(nothing?.classList.contains("meridian-nothing--block")).toBe(true);
  });

  it("negative control: it is not the empty shape", () => {
    // `empty` asserts that the read came back with nothing, which for a diff means
    // asserting that a workspace has no changes. The two render as different
    // shapes and the pane must never reach for the second.
    const { container } = render(<DiffPane context={contextFor(WORKSPACE_ENTITY)} />);
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("says something different about a repository than about a checkout", () => {
    // A diff address admits the sidebar card's five subjects, and a repository is
    // not a working tree: a sentence written for a checkout would tell someone
    // looking at a repository that their tree is unchanged — a claim about a
    // workspace this pane was never opened over. Both arms still say the question
    // was not put, which is the one thing that is true of every subject.
    const overWorkspace = render(<DiffPane context={contextFor(WORKSPACE_ENTITY)} />);
    const overRepo = render(<DiffPane context={contextFor(REPO_ENTITY)} />);
    const readAbsence = (container: HTMLElement): string =>
      container.querySelector(".meridian-nothing")?.textContent ?? "";
    expect(readAbsence(overRepo.container)).not.toBe("");
    expect(readAbsence(overRepo.container)).not.toBe(readAbsence(overWorkspace.container));
    expect(overRepo.container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("negative control: no subject renders the absence blank", () => {
    // The rule this pane owes every subject it did not author a reading for. A blank
    // region is the one answer that says nothing at all, and it is what a body that
    // fell through its own copy table would render.
    for (const entity of [
      WORKSPACE_ENTITY,
      REPO_ENTITY,
      { kind: "worktree", id: "worktree-1" } as const,
      { kind: "invite", id: "invite-1" } as const,
      { kind: "participant", id: "participant-1" } as const,
    ]) {
      const { container } = render(<DiffPane context={contextFor(entity)} />);
      expect(container.querySelector(".meridian-nothing")?.textContent, entity.kind).not.toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// The pane with a diff in it. Everything above is the chrome and the absence;
// what follows is the surface `DiffPane.tsx` actually describes — the compared states,
// the attribution badge, the file list, and the rows.

describe("diff pane — the header a diff gives it", () => {
  it("names the compared states and the attribution mode", () => {
    const { container } = render(
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={buildDiffFixture(SMALL_DIFF_SHAPE)} />,
    );
    const subjectBar = container.querySelector(".meridian-diff-pane__subject-bar");
    expect(subjectBar?.textContent).toContain("Run-attributed");
    expect(subjectBar?.textContent).toContain("main");
    expect(subjectBar?.textContent).toContain("feat/rate-limit-wiring");
  });

  it("renders a workspace-fallback diff's workspace, and no run anywhere", () => {
    // `Spec-011 §Pitfalls To Avoid` names pretending a workspace diff is
    // run-attributed. The union makes the wrong shape unrepresentable; this is
    // the check that the renderer did not reintroduce it by reaching elsewhere.
    const fallbackDiff = buildDiffFixture(SMALL_DIFF_SHAPE, WORKSPACE_FALLBACK_ATTRIBUTION);
    const { container } = render(
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={fallbackDiff} />,
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
    for (const attribution of [RUN_ATTRIBUTION, WORKSPACE_FALLBACK_ATTRIBUTION]) {
      const { container } = render(
        <DiffPane
          context={contextFor(WORKSPACE_ENTITY)}
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
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={buildDiffFixture(SMALL_DIFF_SHAPE)} />,
    );
    expect(container.querySelectorAll(".meridian-diff-files__entry").length).toBe(
      SMALL_DIFF_SHAPE.fileCount + 1,
    );
    expect(container.querySelector(".meridian-diff")).not.toBeNull();
  });

  it("narrows the rows to the file a person selects", () => {
    const { container, getByRole } = render(
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={buildDiffFixture(SMALL_DIFF_SHAPE)} />,
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
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={buildDiffFixture(SMALL_DIFF_SHAPE)} />,
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
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={UNEVEN_GAP_DIFF} />,
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
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={UNEVEN_GAP_DIFF} />,
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
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={buildDiffFixture(SMALL_DIFF_SHAPE)} />,
    );
    fireEvent.click(getByRole("button", { name: /module-01\.ts/u }));
    rerender(<DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={OTHER_DIFF} />);
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
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={buildDiffFixture(SMALL_DIFF_SHAPE)} />,
    );
    const gapCountBefore = container.querySelectorAll(".meridian-diff__row--gap").length;
    fireEvent.click(getAllByRole("button", { name: /Expand \d+ hidden lines/u })[0]!);
    expect(container.querySelectorAll(".meridian-diff__row--gap").length).toBeLessThan(
      gapCountBefore,
    );

    rerender(<DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={OTHER_DIFF} />);
    expect(container.querySelectorAll(".meridian-diff__row--gap").length).toBe(gapCountBefore);
  });

  it("negative control: the SAME model object keeps the selection and the expansion", () => {
    // Without this, the two cases above would pass over a pane that reset its
    // view state on every render — which would take the selection away the
    // instant anything else in the console moved.
    const sameDiff = buildDiffFixture(SMALL_DIFF_SHAPE);
    const { container, getAllByRole, getByRole, rerender } = render(
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={sameDiff} />,
    );
    fireEvent.click(getByRole("button", { name: /module-01\.ts/u }));
    fireEvent.click(getAllByRole("button", { name: /Expand \d+ hidden lines/u })[0]!);
    const gapCountAfterExpanding = container.querySelectorAll(".meridian-diff__row--gap").length;

    rerender(<DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={sameDiff} />);
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
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={buildDiffFixture(SMALL_DIFF_SHAPE)} />,
    );
    fireEvent.click(getByRole("button", { name: "Wrap long lines" }));
    expect(container.querySelector(".meridian-diff--wrap")).not.toBeNull();
    rerender(<DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={OTHER_DIFF} />);
    expect(container.querySelector(".meridian-diff--wrap")).not.toBeNull();
  });
});

describe("diff pane — the toolbar", () => {
  it("offers the four renderer-local controls, with marks on by default", () => {
    // `DiffToolbar.tsx`'s density rule: attribution marks are ON in the pane and OFF
    // in the card, one toggle away in both.
    const { getByRole } = render(
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={buildDiffFixture(SMALL_DIFF_SHAPE)} />,
    );
    expect(getByRole("toolbar", { name: "Diff view controls" })).toBeDefined();
    expect(getByRole("button", { name: "Attribution marks" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("switches the renderer between unified and split", () => {
    const { container, getByRole } = render(
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={buildDiffFixture(SMALL_DIFF_SHAPE)} />,
    );
    expect(container.querySelectorAll(".meridian-diff__side--base").length).toBe(0);
    fireEvent.click(getByRole("button", { name: "Unified view" }));
    expect(container.querySelectorAll(".meridian-diff__side--base").length).toBeGreaterThan(0);
  });

  it("negative control: a toggle actually moves the renderer, not just its own state", () => {
    // Without this, a toolbar whose values nothing read would pass every
    // `aria-pressed` assertion above while changing nothing on screen.
    const { container, getByRole } = render(
      <DiffPane context={contextFor(WORKSPACE_ENTITY)} diff={buildDiffFixture(SMALL_DIFF_SHAPE)} />,
    );
    expect(container.querySelector(".meridian-diff--wrap")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Wrap long lines" }));
    expect(container.querySelector(".meridian-diff--wrap")).not.toBeNull();
  });
});
