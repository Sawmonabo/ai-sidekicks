// The execution-mode capabilities read names exactly one scope: a mount (what a workspace there
// could do) or a workspace (what it may do now). With both, a handler picking one would answer a
// pre-bind question with the narrower per-workspace answer.
import { describe, expect, it } from "vitest";

import { WorkspaceExecutionModeCapabilitiesReadRequestSchema } from "../workspace.js";

const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const WORKSPACE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";

const parseCapabilitiesRequest = (request: Record<string, unknown>) =>
  WorkspaceExecutionModeCapabilitiesReadRequestSchema.safeParse(request);

describe("WorkspaceExecutionModeCapabilitiesReadRequestSchema (exactly-one scope refinement)", () => {
  it("accepts a MOUNT-scoped read — what could a workspace on this mount do", () => {
    expect(parseCapabilitiesRequest({ repoMountId: REPO_MOUNT_ID }).success).toBe(true);
  });

  it("REJECTS a request supplying both `repoMountId` and `workspaceId`", () => {
    const result = parseCapabilitiesRequest({
      repoMountId: REPO_MOUNT_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Both ids are well formed because Zod skips refinements on an aborted payload: a malformed
      // id would fail on its own error first.
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.join("\n")).toContain("MUST carry exactly one of");
    }
  });

  it("REJECTS a request supplying neither id", () => {
    expect(parseCapabilitiesRequest({}).success).toBe(false);
  });

  it("treats an explicit `undefined` as absence, not as presence", () => {
    // JSON cannot carry `undefined`, so the predicate counts defined values; a key-presence test
    // would invert both rows.
    expect(
      parseCapabilitiesRequest({ repoMountId: REPO_MOUNT_ID, workspaceId: undefined }).success,
    ).toBe(true);
    expect(
      parseCapabilitiesRequest({ repoMountId: undefined, workspaceId: undefined }).success,
    ).toBe(false);
  });
});
