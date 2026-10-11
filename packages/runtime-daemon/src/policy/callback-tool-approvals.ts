// The approval seam the callback-tool host asks before it runs one of the app's own tools. Each
// tool is gated as it was declared:
//
//   * A read tool runs as the session's own call at every level.
//   * A tool that acts, such as messaging another session or driving the browser, is gated by the
//     calling session's level alone: at a level that asks, the person's ordinary card, and at
//     Sandboxed and YOLO no card.
//   * A tool that starts a workflow takes that same card first, then the permission check's start
//     decision under the asking run's posture.
//
// The card is the daemon's to raise only where the provider runs the tool without asking first,
// as Codex does with the daemon's tool server set to approve; Claude Code asks the person itself
// at the levels that ask, and its classifier reviews the call at Reviewed, before the call reaches
// the host. A tool with no declared gate is refused, so no tool runs unadjudicated.

import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";

import type { ApprovalService } from "../approvals/service.js";
import type {
  CallbackToolApprovalOutcome,
  CallbackToolApprovalRequest,
  CallbackToolApprovalSeam,
} from "../provider/callback-tool-host.js";
import type { PermissionCheckService } from "./permission-check.js";

/**
 * How one of the app's own tools is gated: `read` for a tool that only reads what the calling
 * session may already read, `level` for one that acts and is gated by the session's level alone,
 * and `workflow_start` for one that starts the workflow its arguments name, read by
 * `workflowIdOf`, which answers `undefined` for arguments that name none.
 */
export type CallbackToolGate =
  | { readonly kind: "read" }
  | { readonly kind: "level" }
  | {
      readonly kind: "workflow_start";
      readonly workflowIdOf: (
        toolArguments: Readonly<Record<string, unknown>>,
      ) => WorkflowDefinitionId | undefined;
    };

/** What the seam is built over, once per provider. */
export interface CallbackToolApprovalsDeps {
  readonly permissionCheck: Pick<PermissionCheckService, "check">;
  readonly approvals: Pick<ApprovalService, "waitForSettle">;
  readonly gatesByTool: ReadonlyMap<string, CallbackToolGate>;
  /**
   * Whether the provider asks the person, or its reviewer, before each of the app's own tools runs
   * at the levels that ask, so the seam raises no card of its own: Claude Code does, and Codex,
   * which runs the daemon's tool server's tools unasked, does not.
   */
  readonly doesProviderAsk: boolean;
}

// What the agent reads when its call names a tool no gate was declared for.
const UNGATED_TOOL_REFUSAL = "This tool has no approval gate, so it does not run.";

// What the agent reads when its call names no workflow to start.
const NO_WORKFLOW_REFUSAL = "This call names no workflow to start.";

// What the agent reads when the person declined the call on its card.
const DECLINED_REFUSAL = "The person declined this call.";

// What the agent reads when the call's card ended unanswered with its run or its session.
const CANCELED_REFUSAL = "This call's approval ended unanswered, so it did not run.";

/**
 * The callback-tool host's approval seam, over the permission check and the gate each of the app's
 * own tools was declared with.
 */
export class CallbackToolApprovals implements CallbackToolApprovalSeam {
  readonly #deps: CallbackToolApprovalsDeps;

  constructor(deps: CallbackToolApprovalsDeps) {
    this.#deps = deps;
  }

  /**
   * Adjudicates one invocation by its tool's gate, waiting on the person's card where the level
   * asks and the provider did not; a tool with none is refused. Rejects when the card could not be
   * raised or waited on.
   */
  async evaluate(request: CallbackToolApprovalRequest): Promise<CallbackToolApprovalOutcome> {
    const gate = this.#deps.gatesByTool.get(request.toolName);
    if (gate === undefined) {
      return { decision: "deny", basis: "policy", reason: UNGATED_TOOL_REFUSAL };
    }
    if (gate.kind === "read") {
      return { decision: "allow", basis: "policy" };
    }
    // Read before any card, so a call naming no workflow asks the person nothing.
    const workflowId = gate.kind === "workflow_start" ? gate.workflowIdOf(request.arguments) : null;
    if (workflowId === undefined) {
      return { decision: "deny", basis: "policy", reason: NO_WORKFLOW_REFUSAL };
    }
    const levelOutcome = await this.#applyLevel(request);
    if (levelOutcome.decision === "deny" || workflowId === null) {
      return levelOutcome;
    }
    const started = await this.#deps.permissionCheck.check({
      kind: "workflow_start",
      workflowId,
      askingRunId: request.runId,
    });
    return started.allowed
      ? levelOutcome
      : { decision: "deny", basis: "policy", reason: started.refusal };
  }

  // The session's level over a call that acts: where the provider asked already it stands, else
  // the check raises the card at a level that asks and the call waits on the person's answer.
  async #applyLevel(request: CallbackToolApprovalRequest): Promise<CallbackToolApprovalOutcome> {
    if (this.#deps.doesProviderAsk) {
      return { decision: "allow", basis: "policy" };
    }
    const checked = await this.#deps.permissionCheck.check({
      kind: "tool_call",
      sessionId: request.sessionId,
      runId: request.runId,
      toolName: request.toolName,
      toolCallId: request.toolCallId,
    });
    if (checked.reason !== "pending_approval") {
      return checked.allowed
        ? { decision: "allow", basis: "policy" }
        : { decision: "deny", basis: "policy", reason: checked.refusal };
    }
    const settled = await this.#deps.approvals.waitForSettle(checked.approvalRequestId);
    switch (settled) {
      case "approved":
        return { decision: "allow", basis: "user-grant" };
      case "rejected":
        return { decision: "deny", basis: "user-refusal", reason: DECLINED_REFUSAL };
      case "canceled":
        return { decision: "deny", basis: "policy", reason: CANCELED_REFUSAL };
    }
  }
}
