// The diff pane while it holds no change set: its chrome, the create it offers, and
// the one thing its absence must not say.
//
// Three claims, and the third is the reason this file exists. The pane names itself by
// its whole trail and the entity it is a view of arrives wire-verbatim. Two of the five
// subjects a diff pane opens over can be keyed by the create wire and three cannot, so
// a control is offered over exactly those two. And an unasked question renders as
// `not-checked` and never as `empty`, because `empty` is the console asserting that a
// workspace has no changes. A pane
// that regressed into `empty` would look identical to a reviewer and would be stating a
// fact nobody established.
//
// WHAT THE PANE DRAWS ONCE IT HOLDS A MODEL is `DiffPane.change-set.test.tsx`, beside
// this file: the compared states, the file list, the rows, and the toolbar are read for
// a different reason and share none of these cases' subjects.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildDiffFixture } from "./diff-fixture.test-support.js";
import {
  SMALL_DIFF_SHAPE,
  WORKSPACE_FALLBACK_ATTRIBUTION,
} from "./diff-fixture-shapes.test-support.js";
import { paneSubjectCrumb, paneTrailCrumbs } from "../pane-chrome.test-support.js";

import { DiffPane } from "./DiffPane.js";
import {
  DIFF_PANE_WORKSPACE_ENTITY,
  diffPaneContextFor,
  installDiffPaneLayout,
  type DiffPaneContext,
} from "./diff-pane.test-support.js";
import { paneContext } from "../pane-contexts.test-support.js";
import { createFixtureBridge } from "../../bridge/index.js";
import { REPOS_SCENARIO } from "../../bridge/scenario/repos/repos.js";
import { SessionStore } from "../../store/index.js";

const WORKSPACE_ENTITY = DIFF_PANE_WORKSPACE_ENTITY;
const REPO_ENTITY = { kind: "repo", id: "repo-sidekicks" } as const;

installDiffPaneLayout();

describe("diff pane — the chrome it wears", () => {
  it("is named by the whole trail, not by the word Diff", () => {
    // The claim the binding exists for. A body drawing its own header named every diff
    // pane in a deck "Diff"; the chrome names it by where it is, so two panes of one
    // kind are told apart by the subjects they are views of.
    const { getByRole } = render(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} />);
    const region = getByRole("region", { name: /Diff$/u });
    expect(region.textContent).toContain(WORKSPACE_ENTITY.id);
    expect(() => getByRole("region", { name: "Diff" })).toThrow();
  });

  it("renders the subject verbatim as the trail's last address crumb", () => {
    const { container } = render(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} />);
    // No session store on this context, so the trail is the entity and the pane's own
    // name — which is what an address carrying one scope should draw, rather than a
    // placeholder standing in for the session it has not got.
    expect(paneTrailCrumbs(container)).toStrictEqual([WORKSPACE_ENTITY.id, "Diff"]);
  });

  it("negative control: the subject crumb is read from the address, not fixed", () => {
    // Without this, the cases above would pass over a chrome that rendered a constant.
    // A diff address always carries its entity — the arm has no shape in which it is
    // absent — so the honest control is a second subject rather than none.
    const { container } = render(<DiffPane context={diffPaneContextFor(REPO_ENTITY)} />);
    expect(paneSubjectCrumb(container)).toBe(REPO_ENTITY.id);
  });
});

/**
 * The same pane with the collaborators the create surface needs.
 *
 * A SECOND BUILDER RATHER THAN A WIDER SHARED ONE, because the two answer different
 * questions: `diffPaneContextFor` is about what the chrome renders from the address
 * alone, and the cases below are about a body that resolves a subject and arms refresh
 * triggers — which needs a real bridge and a real store or it renders the absence arm
 * instead, silently, and every case here would pass against a pane that had lost the
 * surface. It stays in this file because this is its only caller: the change-set half
 * mounts no create.
 */
function reachableContextFor(entity: DiffPaneContext["entity"]): DiffPaneContext {
  return paneContext({
    address: { kind: "diff", entity },
    paneId: "pane-diff-2",
    bridge: createFixtureBridge({ scenario: REPOS_SCENARIO }),
    sessionStore: new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
  });
}

describe("diff pane — where a pane holding no model gets one", () => {
  it("offers the create over a subject the wire can be keyed by", () => {
    const { container } = render(<DiffPane context={reachableContextFor(WORKSPACE_ENTITY)} />);
    expect(container.querySelector(".meridian-diff-create")).not.toBeNull();
    // The absence copy stays above it: nothing has been asked yet, which is still true.
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("negative control: a repository names no checkout, so no control is offered over one", () => {
    // A repository holds several checkouts and resolves to no one of them, so the
    // create wire has no key for it — and an offered control could only refuse.
    const { container } = render(<DiffPane context={reachableContextFor(REPO_ENTITY)} />);
    expect(container.querySelector(".meridian-diff-create")).toBeNull();
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("negative control: a model handed in is drawn, and no create is offered beside it", () => {
    // The prop survives the create surface: a caller that already holds a model is
    // asking a different question from a pane that holds none.
    const { container } = render(
      <DiffPane
        context={reachableContextFor(WORKSPACE_ENTITY)}
        diff={buildDiffFixture(SMALL_DIFF_SHAPE, WORKSPACE_FALLBACK_ATTRIBUTION)}
      />,
    );
    expect(container.querySelector(".meridian-diff-create")).toBeNull();
    expect(container.querySelector(".meridian-diff-pane")).not.toBeNull();
  });
});

describe("diff pane — the absence it renders", () => {
  it("says the question was not put, on a surface", () => {
    const { container } = render(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} />);
    const nothing = container.querySelector(".meridian-nothing");
    expect(nothing?.classList.contains("meridian-nothing--not-checked")).toBe(true);
    expect(nothing?.classList.contains("meridian-nothing--block")).toBe(true);
  });

  it("negative control: it is not the empty shape", () => {
    // `empty` asserts that the read came back with nothing, which for a diff means
    // asserting that a workspace has no changes. The two render as different
    // shapes and the pane must never reach for the second.
    const { container } = render(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} />);
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("says something different about a repository than about a checkout", () => {
    // A diff address admits the sidebar card's five subjects, and a repository is
    // not a working tree: a sentence written for a checkout would tell someone
    // looking at a repository that their tree is unchanged — a claim about a
    // workspace this pane was never opened over. Both arms still say the question
    // was not put, which is the one thing that is true of every subject.
    const overWorkspace = render(<DiffPane context={diffPaneContextFor(WORKSPACE_ENTITY)} />);
    const overRepo = render(<DiffPane context={diffPaneContextFor(REPO_ENTITY)} />);
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
      { kind: "participant", id: "participant-1" } as const,
    ]) {
      const { container } = render(<DiffPane context={diffPaneContextFor(entity)} />);
      expect(container.querySelector(".meridian-nothing")?.textContent, entity.kind).not.toBe("");
    }
  });
});
