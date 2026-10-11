// The built-in rules let the machine's owning user start a workflow an agent or a trigger asks for,
// and a start whose owning user did not resolve is denied.

import { describe, expect, it } from "vitest";

import type { UserId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";

import { loadAuthorizer } from "../authorizer.js";
import { checkWorkflowStart } from "../workflow-start.js";

const WORKFLOW_ID = "workflow-1" as WorkflowDefinitionId;

describe("checkWorkflowStart", () => {
  it("allows the owning user's start under the built-in rules and denies an unresolved owner", async () => {
    const authorizer = await loadAuthorizer();

    expect(
      checkWorkflowStart(authorizer, { owner: "user-1" as UserId, workflowId: WORKFLOW_ID }),
    ).toEqual({ decision: "allow" });
    expect(
      checkWorkflowStart(authorizer, { owner: undefined, workflowId: WORKFLOW_ID }),
    ).toMatchObject({ decision: "deny" });
  });
});
