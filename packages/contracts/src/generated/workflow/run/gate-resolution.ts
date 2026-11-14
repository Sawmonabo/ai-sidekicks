// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The record of one answer to a run's gate: an approval step's question or its chain's question, appended and never rewritten, numbered per run.

import type { ApprovalDecision, ApprovalRequestId } from "../../approval.js";
import type { WireInstant } from "../../internal/wire-scalars.js";
import type { DeviceId } from "../../trust-statement.js";
import type { WorkflowNodeId } from "../definition/document.js";
import type { WorkflowRunId } from "./id.js";

/**
 * Identifies one answer to a run's gate, its append-only row's id; the
 * `workflow.gate.resolved` event names it.
 */
export type WorkflowGateResolutionId = string & { readonly __brand: "WorkflowGateResolutionId" };
/**
 * The category of the approval request a gate answered: an approval's categories but a plan's,
 * which no workflow gate asks.
 */
export type WorkflowGateApprovalCategory =
  | "toolExecution"
  | "fileWrite"
  | "networkAccess"
  | "destructiveGit"
  | "gate";
/**
 * One answer to a gate of a run, as its append-only row holds it. An approval step's answer
 * names the step's node; a chain's question belongs to the run and names none.
 */
export type WorkflowGateResolution =
  | {
      gateKind: "human.approval";
      /**
       * The answer's id.
       */
      gateResolutionId: WorkflowGateResolutionId;
      /**
       * The run whose gate it answered.
       */
      workflowRunId: WorkflowRunId;
      /**
       * Which of the run's answers, counted from 1.
       */
      sequence: number;
      /**
       * The approval request's category, where the request carries one.
       */
      approvalCategory?: WorkflowGateApprovalCategory;
      /**
       * The approval request answered.
       */
      approvalRequestId: ApprovalRequestId;
      /**
       * The answer.
       */
      outcome: ApprovalDecision;
      /**
       * The device that answered.
       */
      deviceId: DeviceId;
      /**
       * When.
       */
      resolvedAt: WireInstant;
      /**
       * What the answer was given about: its scope, the resource and the reason
       * text.
       */
      decisionContext: {
        [k: string]: unknown | undefined;
      };
      /**
       * The approval step answered.
       */
      nodeId: WorkflowNodeId;
    }
  | {
      gateKind: "chain";
      /**
       * The answer's id.
       */
      gateResolutionId: WorkflowGateResolutionId;
      /**
       * The run whose gate it answered.
       */
      workflowRunId: WorkflowRunId;
      /**
       * Which of the run's answers, counted from 1.
       */
      sequence: number;
      /**
       * The approval request's category, where the request carries one.
       */
      approvalCategory?: WorkflowGateApprovalCategory;
      /**
       * The approval request answered.
       */
      approvalRequestId: ApprovalRequestId;
      /**
       * The answer.
       */
      outcome: ApprovalDecision;
      /**
       * The device that answered.
       */
      deviceId: DeviceId;
      /**
       * When.
       */
      resolvedAt: WireInstant;
      /**
       * What the answer was given about: its scope, the resource and the reason
       * text.
       */
      decisionContext: {
        [k: string]: unknown | undefined;
      };
      /**
       * Never present: a chain's question belongs to the run.
       */
      nodeId?: never;
    };

export { validateWorkflowGateResolutionId } from "../../checks/workflow/run/gate-resolution.js";
