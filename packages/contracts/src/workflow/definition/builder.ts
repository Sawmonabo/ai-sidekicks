// The state kept beside a workflow's versions, which saves no new version: the enabled
// switch, the canvas layout, the permission level, pinned test data, the builder's unsaved
// draft, the expression preview, and the webhook token and listener, with the refusals they
// answer with. The method table that lists these methods is in `workflow/definition/methods.ts`.
import { z } from "zod";

import { countSchema, isoDateTimeSchema, portSchema } from "../../internal/wire-scalars.js";
import { PermissionLevelSchema, type PermissionLevel } from "../../session/controls/methods.js";
import {
  WorkflowDefinitionIdSchema,
  WorkflowDraftDocumentSchema,
  WorkflowLayoutSchema,
  WorkflowNodeIdSchema,
  WorkflowPinnedItemSchema,
  type WorkflowDefinitionId,
  type WorkflowDraftDocument,
  type WorkflowLayout,
  type WorkflowNodeId,
  type WorkflowPinnedItem,
} from "./definition.js";

// Refusals

/**
 * A workflow turned on with a trigger that cannot be armed; nothing turns on.
 *
 * @consumedBy the handler that returns the `workflow.trigger_unarmable` error
 */
export const WORKFLOW_TRIGGER_UNARMABLE_CODE = "workflow.trigger_unarmable" as const;

/**
 * A webhook call whose bearer token does not match the workflow's, or that came while
 * the workflow has no token. It is recorded as the workflow's last fire.
 *
 * @consumedBy the handler that returns the `workflow.webhook_token_mismatch` error
 */
export const WORKFLOW_WEBHOOK_TOKEN_MISMATCH_CODE = "workflow.webhook_token_mismatch" as const;

// Settings kept beside a version: enabled, layout, pinned data

/**
 * The `workflow.enabledSet` input: arm or disarm every trigger of one workflow. A
 * trigger that cannot be armed refuses the switch with
 * {@link WORKFLOW_TRIGGER_UNARMABLE_CODE}, and nothing turns on.
 */
export interface WorkflowEnabledSetRequest {
  definitionId: WorkflowDefinitionId;
  enabled: boolean;
}
/** Wire schema for {@link WorkflowEnabledSetRequest}. */
export const WorkflowEnabledSetRequestSchema: z.ZodType<
  WorkflowEnabledSetRequest,
  WorkflowEnabledSetRequest
> = z.object({ definitionId: WorkflowDefinitionIdSchema, enabled: z.boolean() }).strict();

/** The `workflow.enabledSet` result: the switch's state and how many triggers are armed now. */
export interface WorkflowEnabledSetResponse {
  definitionId: WorkflowDefinitionId;
  enabled: boolean;
  armedTriggerCount: number;
}
/** Wire schema for {@link WorkflowEnabledSetResponse}. */
export const WorkflowEnabledSetResponseSchema: z.ZodType<WorkflowEnabledSetResponse> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    enabled: z.boolean(),
    armedTriggerCount: countSchema,
  })
  .strict();

/**
 * The `workflow.layoutSet` input: the whole canvas layout, saved on the definition
 * without a new version. Saved versions keep the layout they were written with.
 */
export interface WorkflowLayoutSetRequest {
  definitionId: WorkflowDefinitionId;
  layout: WorkflowLayout;
}
/** Wire schema for {@link WorkflowLayoutSetRequest}. */
export const WorkflowLayoutSetRequestSchema: z.ZodType<
  WorkflowLayoutSetRequest,
  WorkflowLayoutSetRequest
> = z.object({ definitionId: WorkflowDefinitionIdSchema, layout: WorkflowLayoutSchema }).strict();

/** When a setting kept beside the definition was stored. */
export interface WorkflowDefinitionSettingResponse {
  definitionId: WorkflowDefinitionId;
  updatedAt: string;
}
/** Wire schema for {@link WorkflowDefinitionSettingResponse}. */
export const WorkflowDefinitionSettingResponseSchema: z.ZodType<WorkflowDefinitionSettingResponse> =
  z.object({ definitionId: WorkflowDefinitionIdSchema, updatedAt: isoDateTimeSchema }).strict();

/**
 * The `workflow.permissionLevelUpdate` input: the level every run of the workflow uses, a live
 * run from its next step. A new workflow starts at `yolo`. The level sits outside the hashed
 * body, so a change mints no version.
 */
export interface WorkflowPermissionLevelUpdateRequest {
  definitionId: WorkflowDefinitionId;
  level: PermissionLevel;
}
/** Wire schema for {@link WorkflowPermissionLevelUpdateRequest}. */
export const WorkflowPermissionLevelUpdateRequestSchema: z.ZodType<
  WorkflowPermissionLevelUpdateRequest,
  WorkflowPermissionLevelUpdateRequest
> = z.object({ definitionId: WorkflowDefinitionIdSchema, level: PermissionLevelSchema }).strict();

/** The level the workflow now runs at. */
export interface WorkflowPermissionLevelUpdateResponse {
  definitionId: WorkflowDefinitionId;
  level: PermissionLevel;
}
/** Wire schema for {@link WorkflowPermissionLevelUpdateResponse}. */
export const WorkflowPermissionLevelUpdateResponseSchema: z.ZodType<WorkflowPermissionLevelUpdateResponse> =
  z.object({ definitionId: WorkflowDefinitionIdSchema, level: PermissionLevelSchema }).strict();

/**
 * The `workflow.pinDataSet` input: pin items onto one node as test data, or unpin with
 * `null`, without a new version. Pinned data is honored only in manual runs.
 */
export interface WorkflowPinDataSetRequest {
  definitionId: WorkflowDefinitionId;
  nodeId: WorkflowNodeId;
  items: WorkflowPinnedItem[] | null;
}
/** Wire schema for {@link WorkflowPinDataSetRequest}. */
export const WorkflowPinDataSetRequestSchema: z.ZodType<
  WorkflowPinDataSetRequest,
  WorkflowPinDataSetRequest
> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    nodeId: WorkflowNodeIdSchema,
    items: z.array(WorkflowPinnedItemSchema).nullable(),
  })
  .strict();

/** The `workflow.pinDataSet` result: whether the node is pinned now. */
export interface WorkflowPinDataSetResponse {
  definitionId: WorkflowDefinitionId;
  nodeId: WorkflowNodeId;
  pinned: boolean;
}
/** Wire schema for {@link WorkflowPinDataSetResponse}. */
export const WorkflowPinDataSetResponseSchema: z.ZodType<WorkflowPinDataSetResponse> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    nodeId: WorkflowNodeIdSchema,
    pinned: z.boolean(),
  })
  .strict();

// The builder's draft

/**
 * The `workflow.draftUpdate` input: the builder's whole unsaved document, which replaces
 * the one held. The daemon holds one draft per saved workflow, named by `definitionId`
 * with the version it was opened from, and one for a new workflow, which omits both.
 */
export interface WorkflowDraftUpdateRequest {
  definitionId?: WorkflowDefinitionId | undefined;
  basedOnVersionNumber?: number | undefined;
  document: WorkflowDraftDocument;
}
/** Wire schema for {@link WorkflowDraftUpdateRequest}. */
export const WorkflowDraftUpdateRequestSchema: z.ZodType<
  WorkflowDraftUpdateRequest,
  WorkflowDraftUpdateRequest
> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema.optional(),
    basedOnVersionNumber: z.number().int().positive().optional(),
    document: WorkflowDraftDocumentSchema,
  })
  .strict()
  .refine(
    (request) => request.basedOnVersionNumber === undefined || request.definitionId !== undefined,
    {
      message:
        "A draft is based on a version only of a saved workflow, so it names the definition.",
    },
  );

/** When the daemon stored the draft. */
export interface WorkflowDraftUpdateResponse {
  updatedAt: string;
}
/** Wire schema for {@link WorkflowDraftUpdateResponse}. */
export const WorkflowDraftUpdateResponseSchema: z.ZodType<WorkflowDraftUpdateResponse> = z
  .object({ updatedAt: isoDateTimeSchema })
  .strict();

/**
 * The `workflow.draftRead` input: the draft of the workflow the builder's address names,
 * or, with no `definitionId`, the new workflow's draft. A reload reads it back this way.
 */
export interface WorkflowDraftReadRequest {
  definitionId?: WorkflowDefinitionId | undefined;
}
/** Wire schema for {@link WorkflowDraftReadRequest}. */
export const WorkflowDraftReadRequestSchema: z.ZodType<
  WorkflowDraftReadRequest,
  WorkflowDraftReadRequest
> = z.object({ definitionId: WorkflowDefinitionIdSchema.optional() }).strict();

/** One held draft. */
export interface WorkflowDraft {
  definitionId?: WorkflowDefinitionId | undefined;
  basedOnVersionNumber?: number | undefined;
  document: WorkflowDraftDocument;
  updatedAt: string;
}

/** The `workflow.draftRead` result. A draft that is no longer held is an answer, not an error. */
export interface WorkflowDraftReadResponse {
  draft: WorkflowDraft | null;
}
/** Wire schema for {@link WorkflowDraftReadResponse}. */
export const WorkflowDraftReadResponseSchema: z.ZodType<WorkflowDraftReadResponse> = z
  .object({
    draft: z
      .object({
        definitionId: WorkflowDefinitionIdSchema.optional(),
        basedOnVersionNumber: z.number().int().positive().optional(),
        document: WorkflowDraftDocumentSchema,
        updatedAt: isoDateTimeSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

// workflow.expressionPreview

/**
 * The `workflow.expressionPreview` input: one expression of one node, evaluated in the
 * daemon against an item of the last run. The node is read from the workflow's held draft,
 * else its latest saved version; with no `definitionId`, from the new workflow's draft. It
 * never resolves a secret: a sensitive field previews the secret's name.
 */
export interface WorkflowExpressionPreviewRequest {
  definitionId?: WorkflowDefinitionId | undefined;
  nodeId: WorkflowNodeId;
  expression: string;
  itemIndex?: number | undefined;
}
/** Wire schema for {@link WorkflowExpressionPreviewRequest}. */
export const WorkflowExpressionPreviewRequestSchema: z.ZodType<
  WorkflowExpressionPreviewRequest,
  WorkflowExpressionPreviewRequest
> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema.optional(),
    nodeId: WorkflowNodeIdSchema,
    expression: z.string().min(1),
    itemIndex: countSchema.optional(),
  })
  .strict();

/**
 * The `workflow.expressionPreview` result: the value, or why the expression does not
 * resolve against that item.
 */
export type WorkflowExpressionPreviewResponse =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };
/** Wire schema for {@link WorkflowExpressionPreviewResponse}. */
export const WorkflowExpressionPreviewResponseSchema: z.ZodType<WorkflowExpressionPreviewResponse> =
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
    z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict(),
  ]);

// The webhook token and the listener

/**
 * The `workflow.webhookTokenRotate` input: create the workflow's webhook token, or
 * replace it. The old token is refused from that moment.
 */
export interface WorkflowWebhookTokenRotateRequest {
  definitionId: WorkflowDefinitionId;
}
/** Wire schema for {@link WorkflowWebhookTokenRotateRequest}. */
export const WorkflowWebhookTokenRotateRequestSchema: z.ZodType<
  WorkflowWebhookTokenRotateRequest,
  WorkflowWebhookTokenRotateRequest
> = z.object({ definitionId: WorkflowDefinitionIdSchema }).strict();

/**
 * The `workflow.webhookTokenRotate` result: the new token, shown once. Only its hash is
 * kept, so no later read returns it; a transport that logs replies redacts `token`.
 */
export interface WorkflowWebhookTokenRotateResponse {
  definitionId: WorkflowDefinitionId;
  token: string;
  createdAt: string;
}
/** Wire schema for {@link WorkflowWebhookTokenRotateResponse}. */
export const WorkflowWebhookTokenRotateResponseSchema: z.ZodType<WorkflowWebhookTokenRotateResponse> =
  z
    .object({
      definitionId: WorkflowDefinitionIdSchema,
      token: z.string().min(1),
      createdAt: isoDateTimeSchema,
    })
    .strict();

/** `workflow.webhookListenerRead` takes no members. */
export type WorkflowWebhookListenerReadRequest = Record<string, never>;
/** Wire schema for {@link WorkflowWebhookListenerReadRequest}. */
export const WorkflowWebhookListenerReadRequestSchema: z.ZodType<
  WorkflowWebhookListenerReadRequest,
  WorkflowWebhookListenerReadRequest
> = z.object({}).strict();

const WORKFLOW_WEBHOOK_LISTENER_STATES = ["listening", "port_taken"] as const;

/**
 * The webhook listener: the one loopback port it binds, and whether it listens. With
 * the port held by another program it does not start and no workflow has an address.
 */
export interface WorkflowWebhookListenerReadResponse {
  port: number;
  state: (typeof WORKFLOW_WEBHOOK_LISTENER_STATES)[number];
}
/** Wire schema for {@link WorkflowWebhookListenerReadResponse}. */
export const WorkflowWebhookListenerReadResponseSchema: z.ZodType<WorkflowWebhookListenerReadResponse> =
  z
    .object({
      port: portSchema,
      state: z.enum(WORKFLOW_WEBHOOK_LISTENER_STATES),
    })
    .strict();
