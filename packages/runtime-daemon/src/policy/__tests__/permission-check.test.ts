// A workflow start through the permission check: every check is evaluated, an identical one too,
// with the machine's owner and the asking run's posture read afresh, so nothing it decided is
// served again after either changed; a start whose owner does not resolve is refused without
// evaluation, and a trigger's start, which no run asks for, carries no posture.

import { describe, expect, it } from "vitest";

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { UserId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";

import type { PolicyRequest } from "../authorizer.js";
import { PermissionCheckService } from "../permission-check.js";

const OWNER = "user-1" as UserId;
const WORKFLOW_ID = "workflow-1" as WorkflowDefinitionId;
const ASKING_RUN = "00000000-0000-7000-8000-0000000000b1" as RunId;

function postureAt(mode: ExecutionPosture["mode"]): ExecutionPosture {
  return { mode, writableRoots: [], credentialPolicyRef: "curated-credentials" };
}

// A check over rules that refuse a start from a run at Read-only, recording each evaluation.
function buildCheck(state: { owner: UserId | undefined; posture: ExecutionPosture | undefined }): {
  check: PermissionCheckService;
  evaluated: PolicyRequest[];
} {
  const evaluated: PolicyRequest[] = [];
  const check = new PermissionCheckService({
    authorizer: {
      decide: (request) => {
        evaluated.push(request);
        const posture = request.context["posture"] as { mode?: string } | undefined;
        return posture?.mode === "readonly"
          ? { decision: "deny", errors: [] }
          : { decision: "allow" };
      },
    },
    approvals: {
      create: () => Promise.reject(new Error("a workflow start raises no card")),
    },
    rules: { findRule: () => undefined },
    agentMemoryFolder: "/data/agent-memory",
    readRunAgent: () => "agent-1",
    readOwner: () => state.owner,
    readPosture: (runId) => (runId === ASKING_RUN ? state.posture : undefined),
  });
  return { check, evaluated };
}

describe("PermissionCheckService, a workflow start", () => {
  it("decides each start afresh on the asking run's posture, and a trigger's start on none", async () => {
    const state = { owner: OWNER, posture: postureAt("ask") as ExecutionPosture | undefined };
    const { check, evaluated } = buildCheck(state);
    const start = {
      kind: "workflow_start",
      workflowId: WORKFLOW_ID,
      askingRunId: ASKING_RUN,
    } as const;

    // The same start twice: each is evaluated, none answered from the first.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await check.check(start)).toEqual({ allowed: true, reason: "policy_allow" });
    }
    state.posture = postureAt("readonly");
    expect(await check.check(start)).toMatchObject({
      allowed: false,
      reason: "denied",
    });
    expect(
      await check.check({
        kind: "workflow_start",
        workflowId: WORKFLOW_ID,
        askingRunId: undefined,
      }),
    ).toEqual({ allowed: true, reason: "policy_allow" });

    expect(evaluated.map((request) => request.context)).toEqual([
      { posture: postureAt("ask") },
      { posture: postureAt("ask") },
      { posture: postureAt("readonly") },
      {},
    ]);
    expect(evaluated.every((request) => request.principal === OWNER)).toBe(true);
  });

  it("refuses a start whose owner does not resolve, evaluating nothing", async () => {
    const { check, evaluated } = buildCheck({ owner: undefined, posture: postureAt("yolo") });

    expect(
      await check.check({
        kind: "workflow_start",
        workflowId: WORKFLOW_ID,
        askingRunId: ASKING_RUN,
      }),
    ).toMatchObject({ allowed: false, reason: "denied" });
    expect(evaluated).toEqual([]);
  });
});
