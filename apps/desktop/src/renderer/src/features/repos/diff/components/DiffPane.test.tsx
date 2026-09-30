// The diff pane while it holds no change set: its chrome, and the one thing its absence must
// not say. The pane is named by its whole trail with the entity wire-verbatim, and an unasked
// question renders `not-checked`, never `empty`, which asserts the workspace has no changes.
// Cases with a model are in `DiffPane.change-set.test.tsx`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildDiffFixture } from "@test/helpers/diff-fixture.js";
import { SMALL_DIFF_SHAPE } from "@test/helpers/diff-fixture-shapes.js";
import { paneSubjectCrumb, paneTrailCrumbs } from "../../pane-chrome.test-support.js";

import { DiffPane } from "./DiffPane.js";
import {
  DIFF_PANE_WORKSPACE_ENTITY,
  diffPaneContextFor,
  installDiffPaneLayout,
} from "./diff-pane.test-support.js";

const WORKSPACE_ENTITY = DIFF_PANE_WORKSPACE_ENTITY;
const WORKTREE_ENTITY = { kind: "worktree", id: "worktree-1" } as const;

installDiffPaneLayout();

describe("diff pane — the chrome it wears", () => {
  it("is named by the whole trail, not by the word Review", () => {
    // A body drawing its own header named every diff pane "Review"; the chrome names it by
    // where it is, so panes of one kind are told apart by their subjects.
    const { getByRole } = render(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} />);
    const region = getByRole("region", { name: /Review$/u });
    expect(region.textContent).toContain(WORKSPACE_ENTITY.id);
    expect(() => getByRole("region", { name: "Review" })).toThrow();
  });

  it("renders the subject verbatim as the trail's last address crumb", () => {
    const { container } = render(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} />);
    // No session store on this context, so the trail is the entity and the pane's own name.
    expect(paneTrailCrumbs(container)).toStrictEqual([WORKSPACE_ENTITY.id, "Review"]);
  });

  it("negative control: the subject crumb is read from the address, not fixed", () => {
    // Negative control: a chrome that rendered a constant would pass above. A diff address always
    // carries its entity, so the control is a second subject rather than none.
    const { container } = render(<DiffPane context={diffPaneContextFor(WORKTREE_ENTITY)} />);
    expect(paneSubjectCrumb(container)).toBe(WORKTREE_ENTITY.id);
  });
});

describe("diff pane — a model handed in", () => {
  it("is drawn in place of the absence", () => {
    // A caller that already holds a model hands it over and the pane draws it.
    const { container } = render(
      <DiffPane
        context={diffPaneContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
      />,
    );
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
    expect(container.querySelector(".meridian-diff-pane")).not.toBeNull();
  });
});

describe("diff pane — the absence it renders", () => {
  it("says the question was not put, in the pane", () => {
    const { container } = render(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} />);
    const nothing = container.querySelector(".meridian-nothing");
    expect(nothing?.classList.contains("meridian-nothing--not-checked")).toBe(true);
    expect(nothing?.classList.contains("meridian-nothing--block")).toBe(true);
  });

  it("negative control: it is not the empty shape", () => {
    // `empty` asserts the read came back with nothing, i.e. that a workspace has no changes;
    // the pane must never reach for it.
    const { container } = render(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} />);
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("negative control: no subject renders the absence blank", () => {
    // A blank region says nothing at all, and is what a body that fell through its copy table
    // would render.
    for (const entity of [WORKSPACE_ENTITY, WORKTREE_ENTITY]) {
      const { container } = render(<DiffPane context={diffPaneContextFor(entity)} />);
      expect(container.querySelector(".meridian-nothing")?.textContent, entity.kind).not.toBe("");
    }
  });
});
