// The record of one answer to a run's gate: an approval step's question or its chain's question.
// Answers are appended and never rewritten, numbered per run, and each names the approval request
// it answered and the device that answered it.
import { z } from "zod";

import {
  ApprovalCategorySchema,
  ApprovalDecisionSchema,
  ApprovalRequestIdSchema,
  type ApprovalCategory,
  type ApprovalDecision,
  type ApprovalRequestId,
} from "../../approval.js";
import { isoDateTimeSchema } from "../../internal/wire-scalars.js";
import { DeviceIdSchema, type DeviceId } from "../../trust-statement.js";
import { WorkflowNodeIdSchema, type WorkflowNodeId } from "../definition/document.js";
import { WorkflowRunIdSchema, type WorkflowRunId } from "./id.js";

/**
 * What a gate is: a `human.approval` step's question, or the question a chain's first run asks once
 * the chain has started as many runs as the person allows.
 */
export const WORKFLOW_GATE_KINDS = ["human.approval", "chain"] as const;
/** One of {@link WORKFLOW_GATE_KINDS}. */
export type WorkflowGateKind = (typeof WORKFLOW_GATE_KINDS)[number];

/**
 * One answer to a gate of a run, as its append-only row holds it. `sequence` counts the run's
 * answers from 1. An approval step's answer names the step's node; a chain's question belongs to
 * the run and names none. `gateResolutionId` is the id the `workflow.gate_resolved` event names.
 */
export type WorkflowGateResolution = {
  gateResolutionId: string;
  workflowRunId: WorkflowRunId;
  sequence: number;
  /** The approval request's category, where the request carries one. */
  approvalCategory?: ApprovalCategory | undefined;
  approvalRequestId: ApprovalRequestId;
  outcome: ApprovalDecision;
  /** The device that answered. */
  deviceId: DeviceId;
  resolvedAt: string;
  /** What the answer was given about: its scope, the resource and the reason text. */
  decisionContext: Record<string, unknown>;
} & (
  | { gateKind: "human.approval"; nodeId: WorkflowNodeId }
  | { gateKind: Exclude<WorkflowGateKind, "human.approval">; nodeId?: undefined }
);
const workflowGateResolutionFields = {
  gateResolutionId: z.string().min(1),
  workflowRunId: WorkflowRunIdSchema,
  sequence: z.number().int().positive(),
  approvalCategory: ApprovalCategorySchema.optional(),
  approvalRequestId: ApprovalRequestIdSchema,
  outcome: ApprovalDecisionSchema,
  deviceId: DeviceIdSchema,
  resolvedAt: isoDateTimeSchema,
  decisionContext: z.record(z.string(), z.unknown()),
};
/**
 * Wire schema for {@link WorkflowGateResolution}: a node exactly on an approval step's answer.

 */
export const WorkflowGateResolutionSchema: z.ZodType<WorkflowGateResolution> = z.discriminatedUnion(
  "gateKind",
  [
    z
      .object({
        ...workflowGateResolutionFields,
        gateKind: z.literal("human.approval"),
        nodeId: WorkflowNodeIdSchema,
      })
      .strict(),
    z
      .object({
        ...workflowGateResolutionFields,
        gateKind: z.enum(WORKFLOW_GATE_KINDS).exclude(["human.approval"]),
      })
      .strict(),
  ],
);
