// The approval seam the callback-tool host asks before it runs one of the app's own tools. Each
// tool is gated as it was declared: a read tool on the session itself, whose own call it is, and a
// tool that starts a workflow through the permission check's start decision, under the asking
// run's posture. A tool with no declared gate is refused, so no tool runs unadjudicated.

import type { WorkflowDefinitionId } from "@ai-sidekicks/contracts/workflow/definition/document";

import type {
  CallbackToolApprovalOutcome,
  CallbackToolApprovalRequest,
  CallbackToolApprovalSeam,
} from "../provider/callback-tool-host.js";
import type { PermissionCheckService } from "./permission-check.js";

/**
 * How one of the app's own tools is gated: `session` for a tool that only reads what the calling
 * session may already read, `workflow_start` for one that starts the workflow its arguments name,
 * read by `workflowIdOf`, which answers `undefined` for arguments that name none.
 */
export type CallbackToolGate =
  | { readonly kind: "session" }
  | {
      readonly kind: "workflow_start";
      readonly workflowIdOf: (
        toolArguments: Readonly<Record<string, unknown>>,
      ) => WorkflowDefinitionId | undefined;
    };

// What the agent reads when its call names a tool no gate was declared for.
const UNGATED_TOOL_REFUSAL = "This tool has no approval gate, so it does not run.";

// What the agent reads when its call names no workflow to start.
const NO_WORKFLOW_REFUSAL = "This call names no workflow to start.";

/**
 * The callback-tool host's approval seam, over the permission check and the gate each of the app's
 * own tools was declared with.
 */
export class CallbackToolApprovals implements CallbackToolApprovalSeam {
  readonly #permissionCheck: Pick<PermissionCheckService, "check">;
  readonly #gatesByTool: ReadonlyMap<string, CallbackToolGate>;

  constructor(
    permissionCheck: Pick<PermissionCheckService, "check">,
    gatesByTool: ReadonlyMap<string, CallbackToolGate>,
  ) {
    this.#permissionCheck = permissionCheck;
    this.#gatesByTool = gatesByTool;
  }

  /** Adjudicates one invocation by its tool's gate; a tool with none is refused. */
  async evaluate(request: CallbackToolApprovalRequest): Promise<CallbackToolApprovalOutcome> {
    const gate = this.#gatesByTool.get(request.toolName);
    if (gate === undefined) {
      return { decision: "deny", basis: "policy", reason: UNGATED_TOOL_REFUSAL };
    }
    if (gate.kind === "session") {
      return { decision: "allow", basis: "policy" };
    }
    const workflowId = gate.workflowIdOf(request.arguments);
    if (workflowId === undefined) {
      return { decision: "deny", basis: "policy", reason: NO_WORKFLOW_REFUSAL };
    }
    const checked = await this.#permissionCheck.check({
      kind: "workflow_start",
      workflowId,
      askingRunId: request.runId,
    });
    return checked.allowed
      ? { decision: "allow", basis: "policy" }
      : { decision: "deny", basis: "policy", reason: checked.refusal };
  }
}
