// The diff pane's chrome, and the one thing it must not say.
//
// Two claims are worth a test here and the second is the reason the file exists.
// The first is ordinary: the pane names itself, and the entity it is a view of
// arrives on screen wire-verbatim with the full string recoverable. The second is
// the rule §10.6 and rule 8 both turn on — that an unasked question renders as
// `not-checked` and never as `empty`, because `empty` is the console asserting that
// a workspace has no changes. A pane that regressed into `empty` would look
// identical to a reviewer and would be stating a fact nobody established.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RUN_ATTRIBUTION,
  SMALL_DIFF_SHAPE,
  WORKSPACE_FALLBACK_ATTRIBUTION,
  buildDiffFixture,
} from "./diff-fixture.js";
import { DIFF_FIXTURE_VIEWPORT_HEIGHT_PX, DiffLayoutFixture } from "./diff-layout-fixture.js";

import { type ConsolePaneContext } from "../../workspace/index.js";
import { DiffPane } from "./DiffPane.js";

/**
 * A pane context whose collaborators are never reached.
 *
 * The cast is `legacy-surfaces.test.ts`'s: these cases are about what the chrome
 * renders from the address, and a real bridge, store pair, and persistence stack
 * would be four constructions none of the assertions below can observe.
 */
function contextFor(entity: ConsolePaneContext["entity"]): ConsolePaneContext {
  return { kind: "diff", entity, paneId: "pane-diff-1" } as unknown as ConsolePaneContext;
}

const WORKSPACE_ENTITY = { kind: "workspace", id: "workspace-sidekicks" } as const;

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

  it("negative control: a pane with no entity renders no subject", () => {
    // Without this, the case above would pass over a chrome that rendered the
    // subject slot unconditionally with an empty string in it.
    const { container } = render(<DiffPane context={contextFor(undefined)} />);
    expect(container.querySelector(".meridian-repos-pane__subject")).toBeNull();
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
});

// ---------------------------------------------------------------------------
// The pane with a diff in it. Everything above is the chrome and the absence;
// what follows is the surface §10.6 actually describes — the compared states,
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

describe("diff pane — the toolbar", () => {
  it("offers the four renderer-local controls, with marks on by default", () => {
    // §10.6's density rule: attribution marks are ON in the pane and OFF in the
    // card, one toggle away in both.
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
