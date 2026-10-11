// The built-in rules let the machine's owning user start a workflow an agent or a trigger asks for,
// with or without the asking run's posture. What the check reads and refuses before the rules is
// tested beside the permission check.

import { describe, expect, it } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { UserId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";

import { loadAuthorizer } from "../authorizer.js";
import { checkWorkflowStart } from "../workflow-start.js";

const OWNER = "user-1" as UserId;
const WORKFLOW_ID = "workflow-1" as WorkflowDefinitionId;

function postureAt(mode: ExecutionPosture["mode"]): ExecutionPosture {
  return {
    mode,
    writableRoots: mode === "sandboxed" ? ["/work/repo/.git"] : [],
    credentialPolicyRef: "curated-credentials",
  };
}

describe("checkWorkflowStart", () => {
  it("allows the owner's start under the built-in rules, with or without a posture", async () => {
    const authorizer = await loadAuthorizer();

    for (const posture of [undefined, postureAt("ask"), postureAt("sandboxed")]) {
      expect(
        checkWorkflowStart(authorizer, { owner: OWNER, workflowId: WORKFLOW_ID, posture }),
      ).toEqual({ decision: "allow" });
    }
  });
});
