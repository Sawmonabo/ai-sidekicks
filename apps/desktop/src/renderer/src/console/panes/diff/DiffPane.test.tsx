// The diff pane's chrome, and the one thing it must not say.
//
// Two claims are worth a test here and the second is the reason the file exists.
// The first is ordinary: the pane names itself, and the entity it is a view of
// arrives on screen wire-verbatim with the full string recoverable. The second is
// the rule §10.6 and rule 8 both turn on — that an unasked question renders as
// `not-checked` and never as `empty`, because `empty` is the console asserting that
// a workspace has no changes. A pane that regressed into `empty` would look
// identical to a reviewer and would be stating a fact nobody established.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
