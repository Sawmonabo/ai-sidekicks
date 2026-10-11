// The app's own tools reach the callback-tool host's approval seam gated as they were declared: a
// tool with no gate is refused, a read tool runs as the session's own call, a tool that acts runs
// by the session's level alone, and a workflow start takes the level's card, then runs only where
// the permission check allows it for the asking run. The card is the daemon's to raise only on a
// provider that runs the tools unasked, as Codex does, and only at the levels that ask.

import { describe, expect, it } from "vitest";

import type { ApprovalRequestId } from "@ai-sidekicks/contracts/approval";
import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId, UserId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";

import type { ApprovalRequestCreateRequest } from "../../approvals/request-create.js";
import type { SettledApprovalState } from "../../approvals/service.js";
import type { CallbackToolApprovalRequest } from "../../provider/callback-tool-host.js";
import { CallbackToolApprovals, type CallbackToolGate } from "../callback-tool-approvals.js";
import type { PolicyRequest } from "../authorizer.js";
import { PermissionCheckService } from "../permission-check.js";

const SESSION_ID = "00000000-0000-7000-8000-000000000001" as SessionId;
const RUN_ID = "00000000-0000-7000-8000-0000000000b1" as RunId;
const REFUSED_WORKFLOW = "workflow-refused" as WorkflowDefinitionId;

function postureAt(mode: ExecutionPosture["mode"]): ExecutionPosture {
  return { mode, writableRoots: [], credentialPolicyRef: "curated-credentials" };
}

const GATES: ReadonlyMap<string, CallbackToolGate> = new Map<string, CallbackToolGate>([
  ["workflow_list", { kind: "read" }],
  ["session_send", { kind: "level" }],
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

// A seam at `level` on a provider that does or does not ask itself, whose cards settle as `answer`
// says, recording each card raised and each start the rules evaluated.
function buildSeam(options: {
  readonly level: ExecutionPosture["mode"];
  readonly doesProviderAsk: boolean;
  readonly answer?: SettledApprovalState;
}): {
  seam: CallbackToolApprovals;
  cards: ApprovalRequestCreateRequest[];
  evaluated: PolicyRequest[];
} {
  const cards: ApprovalRequestCreateRequest[] = [];
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
      create: (card) => {
        cards.push(card);
        return Promise.resolve({ approvalRequestId: `card-${cards.length}` as ApprovalRequestId });
      },
      takeCorrection: () => Promise.resolve(false),
    },
    rules: { findRule: () => undefined },
    agentMemoryFolder: "/data/agent-memory",
    readRunAgent: () => "agent-1",
    readOwner: () => "user-1" as UserId,
    readPosture: (runId) => (runId === RUN_ID ? postureAt(options.level) : undefined),
  });
  const seam = new CallbackToolApprovals({
    permissionCheck,
    approvals: {
      waitForSettle: () =>
        options.answer === undefined
          ? Promise.reject(new Error("no card was to be waited on"))
          : Promise.resolve(options.answer),
    },
    gatesByTool: GATES,
    doesProviderAsk: options.doesProviderAsk,
  });
  return { seam, cards, evaluated };
}

describe("CallbackToolApprovals", () => {
  it("refuses an ungated tool, runs a read tool, starts what the rules allow", async () => {
    const { seam, cards, evaluated } = buildSeam({ level: "yolo", doesProviderAsk: false });

    expect(await seam.evaluate(invocation("shell_run", { command: "rm -rf /" }))).toMatchObject({
      decision: "deny",
      basis: "policy",
    });
    expect(await seam.evaluate(invocation("workflow_list"))).toEqual({
      decision: "allow",
      basis: "policy",
    });
    expect(await seam.evaluate(invocation("session_send"))).toEqual({
      decision: "allow",
      basis: "policy",
    });
    expect(await seam.evaluate(invocation("workflow_run", { workflowId: "workflow-1" }))).toEqual({
      decision: "allow",
      basis: "policy",
    });
    expect(
      await seam.evaluate(invocation("workflow_run", { workflowId: REFUSED_WORKFLOW })),
    ).toMatchObject({ decision: "deny", basis: "policy" });
    expect(await seam.evaluate(invocation("workflow_run", {}))).toMatchObject({
      decision: "deny",
    });

    // YOLO asks nothing; only the starts reached the rules, under the asking run's posture.
    expect(cards).toEqual([]);
    expect(evaluated.map((request) => [request.resource.id, request.context])).toEqual([
      ["workflow-1", { posture: postureAt("yolo") }],
      [REFUSED_WORKFLOW, { posture: postureAt("yolo") }],
    ]);
  });

  it("raises the level's card where the provider asks nothing, before a start", async () => {
    const approved = buildSeam({ level: "ask", doesProviderAsk: false, answer: "approved" });
    expect(await approved.seam.evaluate(invocation("session_send"))).toEqual({
      decision: "allow",
      basis: "user-grant",
    });
    expect(
      await approved.seam.evaluate(invocation("workflow_run", { workflowId: "workflow-1" })),
    ).toEqual({ decision: "allow", basis: "user-grant" });
    // The person's approval does not stand in for the rules: a start they refuse stays refused.
    expect(
      await approved.seam.evaluate(invocation("workflow_run", { workflowId: REFUSED_WORKFLOW })),
    ).toMatchObject({ decision: "deny", basis: "policy" });
    expect(approved.cards).toMatchObject([
      { runId: RUN_ID, category: "tool_execution", scope: "session_send" },
      { runId: RUN_ID, category: "tool_execution", scope: "workflow_run" },
      { runId: RUN_ID, category: "tool_execution", scope: "workflow_run" },
    ]);

    const declined = buildSeam({ level: "reviewed", doesProviderAsk: false, answer: "rejected" });
    expect(
      await declined.seam.evaluate(invocation("workflow_run", { workflowId: "workflow-1" })),
    ).toMatchObject({ decision: "deny", basis: "user-refusal" });
    // A declined start never reaches the rules.
    expect(declined.evaluated).toEqual([]);

    const ended = buildSeam({ level: "readonly", doesProviderAsk: false, answer: "canceled" });
    expect(await ended.seam.evaluate(invocation("session_send"))).toMatchObject({
      decision: "deny",
      basis: "policy",
    });
    // A call whose run has no level to read raises no card and does not run.
    expect(
      await ended.seam.evaluate({
        ...invocation("session_send"),
        runId: "00000000-0000-7000-8000-0000000000b9" as RunId,
      }),
    ).toMatchObject({ decision: "deny", basis: "policy" });
    expect(ended.cards).toHaveLength(1);
  });

  it("raises no card of its own where the provider asked itself, as Claude Code does", async () => {
    const { seam, cards, evaluated } = buildSeam({ level: "ask", doesProviderAsk: true });

    expect(await seam.evaluate(invocation("session_send"))).toEqual({
      decision: "allow",
      basis: "policy",
    });
    expect(await seam.evaluate(invocation("workflow_run", { workflowId: "workflow-1" }))).toEqual({
      decision: "allow",
      basis: "policy",
    });
    expect(cards).toEqual([]);
    expect(evaluated).toHaveLength(1);
  });
});
