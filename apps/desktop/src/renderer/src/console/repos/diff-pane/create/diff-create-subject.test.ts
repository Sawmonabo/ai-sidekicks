// What a diff can be asked for over, and the three addresses that can ask for nothing.
//
// THE MAPPING IS THE SUBJECT. The registered create is a union discriminated on
// `attributionMode` with a run arm and a workspace arm, and the pane opens over five
// entity kinds — so the cases below are one per kind plus the two ways the worktree arm
// answers nothing, and the last of them is the fail-closed one.

import { describe, expect, it } from "vitest";

import {
  comparedStatesNamed,
  diffAttributionFor,
  diffCreateRequestFor,
  diffCreateSubjectFor,
  diffCreateSubjectKey,
  trimmedComparedStates,
} from "./diff-create-subject.js";

const SESSION_ID = "session-diff-subject";
const COMPARED_STATES = { baseRef: "origin/develop", headRef: "feat/thing" };

describe("diffCreateSubjectFor — which addresses name a diffable subject", () => {
  it("takes a workspace address as the fallback arm's own key", () => {
    expect(diffCreateSubjectFor({ kind: "workspace", id: "w-1" }, SESSION_ID)).toStrictEqual({
      kind: "workspace",
      workspaceId: "w-1",
    });
  });

  it("takes a workspace address with no session, because that arm asks nothing", () => {
    expect(diffCreateSubjectFor({ kind: "workspace", id: "w-1" }, undefined)).toStrictEqual({
      kind: "workspace",
      workspaceId: "w-1",
    });
  });

  it("carries a worktree address with the session its run will be read through", () => {
    expect(diffCreateSubjectFor({ kind: "worktree", id: "t-1" }, SESSION_ID)).toStrictEqual({
      kind: "worktree",
      worktreeId: "t-1",
      sessionId: SESSION_ID,
    });
  });

  it("negative control: a worktree on a bare route names nothing, rather than a subject that cannot resolve", () => {
    // Resolving a root's run takes a session-scoped read, so a control offered here
    // could only ever refuse.
    expect(diffCreateSubjectFor({ kind: "worktree", id: "t-1" }, undefined)).toBeUndefined();
  });

  it("negative control: the three kinds with no checkout name nothing at all", () => {
    for (const kind of ["repo", "invite", "participant"]) {
      expect(diffCreateSubjectFor({ kind, id: "x-1" }, SESSION_ID)).toBeUndefined();
    }
  });
});

describe("diffCreateSubjectKey — two id spaces, never one", () => {
  it("keys the same string differently in the two spaces", () => {
    // Nothing about either id says which it is, so a key of the id alone would let one
    // subject's in-flight create settle into the other's reading.
    expect(diffCreateSubjectKey({ kind: "workspace", workspaceId: "same" })).not.toBe(
      diffCreateSubjectKey({ kind: "worktree", worktreeId: "same", sessionId: SESSION_ID }),
    );
  });
});

describe("diffCreateRequestFor — the arm that was sent is the arm that is rendered", () => {
  it("builds the run arm from a resolved run, carrying no workspace", () => {
    const request = diffCreateRequestFor(
      { attributionMode: "run_attributed", runId: "run-1" },
      COMPARED_STATES,
    );
    expect(request).toStrictEqual({
      attributionMode: "run_attributed",
      runId: "run-1",
      baseRef: "origin/develop",
      headRef: "feat/thing",
    });
  });

  it("builds the fallback arm from a workspace, carrying no run", () => {
    const request = diffCreateRequestFor(
      { attributionMode: "workspace_fallback", workspaceId: "w-1" },
      COMPARED_STATES,
    );
    expect(request).toStrictEqual({
      attributionMode: "workspace_fallback",
      workspaceId: "w-1",
      baseRef: "origin/develop",
      headRef: "feat/thing",
    });
  });

  it("derives the rendered attribution from that same arm and never from a reply", () => {
    expect(diffAttributionFor({ attributionMode: "run_attributed", runId: "run-1" })).toStrictEqual(
      { mode: "run_attributed", runId: "run-1" },
    );
    expect(
      diffAttributionFor({ attributionMode: "workspace_fallback", workspaceId: "w-1" }),
    ).toStrictEqual({ mode: "workspace_fallback", workspaceId: "w-1" });
  });
});

describe("the two compared states", () => {
  it("negative control: whitespace is not a ref, so a form holding it is not named", () => {
    expect(comparedStatesNamed({ baseRef: "   ", headRef: "feat/thing" })).toBe(false);
    expect(comparedStatesNamed({ baseRef: "origin/develop", headRef: "" })).toBe(false);
  });

  it("counts both as named once both carry something", () => {
    expect(comparedStatesNamed(COMPARED_STATES)).toBe(true);
  });

  it("trims once, at the boundary", () => {
    expect(trimmedComparedStates({ baseRef: "  main ", headRef: "\thead\n" })).toStrictEqual({
      baseRef: "main",
      headRef: "head",
    });
  });
});
