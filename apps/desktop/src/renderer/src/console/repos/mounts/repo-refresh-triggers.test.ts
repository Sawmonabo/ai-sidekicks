// Which frames the repos family re-reads on, checked against the contract's own census.
//
// The claim worth asserting here is a SET claim rather than a behaviour: the watched
// kinds are derived from the registered type registry, so the case below re-derives the
// expected members from that registry too. A literal list here would be the hand-written
// list the module exists to avoid, restated where nothing could catch its drift.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { REPO_LIFECYCLE_EVENT_KINDS } from "./repo-refresh-triggers.js";

describe("repo refresh triggers — the frames this family watches", () => {
  it("watches every registered repo, workspace, and worktree lifecycle kind", () => {
    const registered = [...SESSION_EVENT_CATEGORY_BY_TYPE.keys()].filter(
      (eventType) =>
        eventType.startsWith("repo.") ||
        eventType.startsWith("workspace.") ||
        eventType.startsWith("worktree."),
    );
    expect([...REPO_LIFECYCLE_EVENT_KINDS].sort()).toStrictEqual([...registered].sort());
    // Non-vacuity: a filter that matched nothing would satisfy the equality above
    // against an empty derivation on both sides, and the section would then re-read on
    // no frame at all while every case here stayed green.
    expect(REPO_LIFECYCLE_EVENT_KINDS.length).toBeGreaterThan(1);
  });

  it("watches the terminal half of a workspace's lifecycle, not only the break", () => {
    // The frames the earlier `workspace.stale`-only set dropped. Each one changes a row
    // the section draws: the mount list, the workspace state and its execution root, or
    // an execution root a proposal gate is bound to.
    expect(REPO_LIFECYCLE_EVENT_KINDS).toContain("workspace.ready");
    expect(REPO_LIFECYCLE_EVENT_KINDS).toContain("workspace.provisioning");
    expect(REPO_LIFECYCLE_EVENT_KINDS).toContain("repo.attached");
    expect(REPO_LIFECYCLE_EVENT_KINDS).toContain("repo.detached");
    expect(REPO_LIFECYCLE_EVENT_KINDS).toContain("worktree.retired");
  });

  it("negative control: a frame from another entity is not watched", () => {
    // Without this the set could be the whole census, and the section would re-read on
    // every run frame and every token count — interval polling with extra steps.
    expect(REPO_LIFECYCLE_EVENT_KINDS).not.toContain("run.queued");
    expect(REPO_LIFECYCLE_EVENT_KINDS).not.toContain("session.created");
    expect(REPO_LIFECYCLE_EVENT_KINDS).not.toContain("agent.attached");
  });
});
