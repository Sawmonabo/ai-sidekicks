// What a git action puts on the wire, held against the registered request shape.
//
// The builder is driven directly here — the shape is a pure function of an act and a
// context, and a case that reached it through the reader would be asserting the request
// through two layers of scheduling. `proposal-gate-actions.test.ts` asserts the same
// request as the ACT sends it, which is the property that closes the loop: this file
// says what the shape is, that one says the sender uses it.

import { describe, expect, it } from "vitest";

import type { BranchContextReading } from "../mounts/branch-context-model.js";
import { gitActionExecuteRequest, gitActionParams } from "./git-action-request.js";

const REPO_MOUNT_ID = "9f2c4a10-0000-4000-8000-000000000003";
const PARTICIPANT_ID = "9f2c4a10-0000-4000-8000-000000000010";

/** A context with an upstream ref set — the ordinary case for a tracked head. */
const TRACKED_CONTEXT: BranchContextReading = {
  branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2301",
  baseBranch: "develop",
  headBranch: "feat/rate-limit-wiring",
  upstreamRef: "origin/feat/rate-limit-wiring",
  executionMode: "worktree",
  worktreeId: "019b7b30-0280-7c11-8420-b1a5c0de2101",
};

/** The same root before anything has been pushed from it: no upstream is set. */
const UNTRACKED_CONTEXT: BranchContextReading = {
  branchContextId: TRACKED_CONTEXT.branchContextId,
  baseBranch: TRACKED_CONTEXT.baseBranch,
  headBranch: TRACKED_CONTEXT.headBranch,
  executionMode: "worktree",
  worktreeId: TRACKED_CONTEXT.worktreeId,
};

describe("gitActionParams — what each act says about the root it runs in", () => {
  it("names the root on a commit, and does not name a push target", () => {
    // The mount the request carries is coarser than the root: one mount can hold
    // several workspaces and each of those several execution roots. So the params are
    // where the root is said, and `branchContextId` is the narrowest thing this console
    // holds for it. A commit sends nowhere, so no upstream rides with it even on a
    // context that has one.
    expect(gitActionParams("commit", TRACKED_CONTEXT)).toStrictEqual({
      branchContextId: TRACKED_CONTEXT.branchContextId,
      headBranch: TRACKED_CONTEXT.headBranch,
    });
  });

  it("carries the context's own upstream ref on a push", () => {
    expect(gitActionParams("push", TRACKED_CONTEXT)).toStrictEqual({
      branchContextId: TRACKED_CONTEXT.branchContextId,
      headBranch: TRACKED_CONTEXT.headBranch,
      upstreamRef: TRACKED_CONTEXT.upstreamRef,
    });
  });

  it("omits the upstream ref entirely where the context has none", () => {
    // Absence is a key that is NOT THERE, never a key holding `undefined`: a context
    // with no upstream has no push target set, and sending the member empty would be
    // this console reporting that it looked and found nothing where nothing was ever
    // set. `exactOptionalPropertyTypes` makes those two different values, and a daemon
    // reading `"upstreamRef" in params` would read them differently too.
    const params = gitActionParams("push", UNTRACKED_CONTEXT);

    expect(params).toStrictEqual({
      branchContextId: UNTRACKED_CONTEXT.branchContextId,
      headBranch: UNTRACKED_CONTEXT.headBranch,
    });
    expect(Object.keys(params)).not.toContain("upstreamRef");
  });

  it("negative control: the params are never empty and never carry the workspace", () => {
    // Without this a builder that returned `{}` for everything would satisfy the
    // omission case above — and a request naming only a mount cannot say which of that
    // mount's roots an act runs in, which is the whole reason `params` is required.
    for (const context of [TRACKED_CONTEXT, UNTRACKED_CONTEXT]) {
      for (const action of ["commit", "push"] as const) {
        const params = gitActionParams(action, context);
        expect(Object.keys(params).length).toBeGreaterThan(0);
        expect(Object.keys(params)).not.toContain("workspaceId");
      }
    }
  });
});

describe("gitActionExecuteRequest — the registered shape, whole", () => {
  it("names the mount, the act, its params, and who pressed it", () => {
    expect(
      gitActionExecuteRequest("push", TRACKED_CONTEXT, {
        repoMountId: REPO_MOUNT_ID,
        causationParticipantId: PARTICIPANT_ID,
      }),
    ).toStrictEqual({
      repoMountId: REPO_MOUNT_ID,
      action: "push",
      params: {
        branchContextId: TRACKED_CONTEXT.branchContextId,
        headBranch: TRACKED_CONTEXT.headBranch,
        upstreamRef: TRACKED_CONTEXT.upstreamRef,
      },
      causationParticipantId: PARTICIPANT_ID,
    });
  });

  it("omits the causation where the caller identity could not be read", () => {
    // The member is optional on the registered request and is attribution rather than
    // authority — the daemon resolves the principal an act runs under from the
    // transport — so an unread identity omits it rather than blocking the act or
    // filling it with a placeholder, which would be a claim about who acted.
    const request = gitActionExecuteRequest("commit", TRACKED_CONTEXT, {
      repoMountId: REPO_MOUNT_ID,
    });

    expect(Object.keys(request)).not.toContain("causationParticipantId");
    expect(request).toStrictEqual({
      repoMountId: REPO_MOUNT_ID,
      action: "commit",
      params: {
        branchContextId: TRACKED_CONTEXT.branchContextId,
        headBranch: TRACKED_CONTEXT.headBranch,
      },
    });
  });

  it("negative control: no request carries a workspace id or a causation run", () => {
    // `workspaceId` is the member this call used to send and that the registered
    // request does not have; `causationRunId` is the one the gate has no run to fill.
    // A builder that spread the whole subject, or defaulted the run to the empty
    // string, would pass every case above.
    const request = gitActionExecuteRequest("push", TRACKED_CONTEXT, {
      repoMountId: REPO_MOUNT_ID,
      causationParticipantId: PARTICIPANT_ID,
    });

    expect(Object.keys(request).sort()).toStrictEqual([
      "action",
      "causationParticipantId",
      "params",
      "repoMountId",
    ]);
  });
});
