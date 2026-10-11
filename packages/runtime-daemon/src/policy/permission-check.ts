// The permission check's request and answer: the in-process gate every sensitive action on this
// machine passes before it runs. No method registers it, since a check made over the wire ahead of
// the action could be stale by the time the action runs, so both shapes are the daemon's own.
import { z } from "zod";

import {
  ApprovalCategorySchema,
  ApprovalRequestIdSchema,
  type ApprovalCategory,
  type ApprovalRequestId,
} from "@ai-sidekicks/contracts/approval";
import { FILE_PATH_MAX_LEN, wireFreeFormString } from "@ai-sidekicks/contracts/free-form-string";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";

import {
  ApprovalResourceDescriptorSchema,
  type ApprovalResourceDescriptor,
} from "../approvals/request-create.js";

/** One action to decide, described as the ask it raises when a person must answer it. */
export interface PermissionCheckRequest {
  runId: RunId;
  category: ApprovalCategory;
  scope: string;
  resourceDescriptor: ApprovalResourceDescriptor;
}
/** Parses a {@link PermissionCheckRequest}. */
export const PermissionCheckRequestSchema: z.ZodType<
  PermissionCheckRequest,
  PermissionCheckRequest
> = z
  .object({
    runId: RunIdSchema,
    category: ApprovalCategorySchema,
    scope: wireFreeFormString(FILE_PATH_MAX_LEN, "PermissionCheckRequest.scope"),
    resourceDescriptor: ApprovalResourceDescriptorSchema,
  })
  .strict();

/**
 * What the check decided. The action runs on `policy_allow` (a built-in permit: the daemon's own
 * answer to a provider ask, or the rules over the app's own tools), `remembered_rule` (the
 * session's own allow, answered by the daemon where the provider has no verb for it) or `approved`
 * (a person's recorded approval of this exact request). It waits on `pending_approval`, naming the
 * one request it opened, and never runs on `denied`: a built-in refusal, a declined request, a host
 * the session blocked, or a refusal because the approval record could not be kept.
 */
export type PermissionCheckResponse =
  | { allowed: true; reason: "policy_allow" | "remembered_rule" | "approved" }
  | { allowed: false; reason: "pending_approval"; approvalRequestId: ApprovalRequestId }
  | { allowed: false; reason: "denied" };
/**
 * Parses a {@link PermissionCheckResponse}: `allowed` agrees with the reason, and a request id
 * rides `pending_approval` and nothing else.
 */
export const PermissionCheckResponseSchema: z.ZodType<
  PermissionCheckResponse,
  PermissionCheckResponse
> = z.union([
  z
    .object({
      allowed: z.literal(true),
      reason: z.enum(["policy_allow", "remembered_rule", "approved"]),
    })
    .strict(),
  z
    .object({
      allowed: z.literal(false),
      reason: z.literal("pending_approval"),
      approvalRequestId: ApprovalRequestIdSchema,
    })
    .strict(),
  z.object({ allowed: z.literal(false), reason: z.literal("denied") }).strict(),
]);
