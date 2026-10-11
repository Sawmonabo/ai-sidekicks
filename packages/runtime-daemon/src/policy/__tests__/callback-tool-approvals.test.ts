// The app's own tools reach the callback-tool host's approval seam gated as they were declared: a
// tool with no gate is refused, a read tool runs as the session's own call, and a workflow start
// runs only where the permission check allows it for the asking run.

import { describe, expect, it } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId, UserId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";

import type { CallbackToolApprovalRequest } from "../../provider/callback-tool-host.js";
import { CallbackToolApprovals, type CallbackToolGate } from "../callback-tool-approvals.js";
import type { PolicyRequest } from "../authorizer.js";
import { PermissionCheckService } from "../permission-check.js";

const SESSION_ID = "00000000-0000-7000-8000-000000000001" as SessionId;
const RUN_ID = "00000000-0000-7000-8000-0000000000b1" as RunId;
const REFUSED_WORKFLOW = "workflow-refused" as WorkflowDefinitionId;
const POSTURE: ExecutionPosture = {
  mode: "ask",
  writableRoots: [],
  credentialPolicyRef: "curated-credentials",
};

const GATES: ReadonlyMap<string, CallbackToolGate> = new Map<string, CallbackToolGate>([
  ["workflow_list", { kind: "session" }],
  [
    "workflow_run",
    {
      kind: "workflow_start",
      workflowIdOf: (toolArguments) =>
        typeof toolArguments["workflowId"] === "string"
          ? (toolArguments["workflowId"] as WorkflowDefinitionId)
          : undefined,
    },
  ],
]);

function invocation(
  toolName: string,
  toolArguments: Record<string, unknown> = {},
): CallbackToolApprovalRequest {
  return {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    toolName,
    toolCallId: "call-1",
    arguments: toolArguments,
  };
}

describe("CallbackToolApprovals", () => {
  it("adjudicates each tool by its declared gate and refuses a tool declared with none", async () => {
    const evaluated: PolicyRequest[] = [];
    const permissionCheck = new PermissionCheckService({
      authorizer: {
        decide: (request) => {
          evaluated.push(request);
          return request.resource.id === REFUSED_WORKFLOW
            ? { decision: "deny", errors: [] }
            : { decision: "allow" };
        },
      },
      approvals: {
        create: () => Promise.reject(new Error("no tool here raises a card")),
        readRequest: () => undefined,
      },
      rules: { findRule: () => undefined },
      agentMemoryFolder: "/data/agent-memory",
      readRunAgent: () => "agent-1",
      readOwner: () => "user-1" as UserId,
      readPosture: (runId) => (runId === RUN_ID ? POSTURE : undefined),
    });
    const approvals = new CallbackToolApprovals(permissionCheck, GATES);

    expect(
      await approvals.evaluate(invocation("shell_run", { command: "rm -rf /" })),
    ).toMatchObject({ decision: "deny", basis: "policy" });
    expect(await approvals.evaluate(invocation("workflow_list"))).toEqual({
      decision: "allow",
      basis: "policy",
    });
    expect(
      await approvals.evaluate(invocation("workflow_run", { workflowId: "workflow-1" })),
    ).toEqual({ decision: "allow", basis: "policy" });
    expect(
      await approvals.evaluate(invocation("workflow_run", { workflowId: REFUSED_WORKFLOW })),
    ).toMatchObject({ decision: "deny", basis: "policy" });
    expect(await approvals.evaluate(invocation("workflow_run", {}))).toMatchObject({
      decision: "deny",
    });

    // Only the starts reached the rules, each under the posture of the run whose agent asked.
    expect(evaluated.map((request) => [request.resource.id, request.context])).toEqual([
      ["workflow-1", { posture: POSTURE }],
      [REFUSED_WORKFLOW, { posture: POSTURE }],
    ]);
  });
});
