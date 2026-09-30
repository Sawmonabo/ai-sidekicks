// The state kept beside a workflow's versions, which saves no new version: the enabled
// switch, the canvas layout, pinned test data, the builder's unsaved draft, the
// expression preview, and the webhook token and listener, with the refusals they answer
// with. The method table that lists these methods is in `workflow-definition-methods.ts`.
import { z } from "zod";

import { countSchema } from "./internal/wire-scalars.js";
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
} from "./workflow-definition.js";

const isoInstant = z.iso.datetime({ offset: true });

// Refusals

/** A workflow turned on with a trigger that cannot be armed; nothing turns on. */
export const WORKFLOW_TRIGGER_UNARMABLE_CODE = "workflow.trigger_unarmable" as const;
/** The type of {@link WORKFLOW_TRIGGER_UNARMABLE_CODE}. */
export type WorkflowTriggerUnarmableCode = typeof WORKFLOW_TRIGGER_UNARMABLE_CODE;

/** An expression whose evaluation ran past its time budget. */
export const WORKFLOW_EXPRESSION_OVER_BUDGET_CODE = "workflow.expression_over_budget" as const;
/** The type of {@link WORKFLOW_EXPRESSION_OVER_BUDGET_CODE}. */
export type WorkflowExpressionOverBudgetCode = typeof WORKFLOW_EXPRESSION_OVER_BUDGET_CODE;

/**
 * A webhook call whose bearer token does not match the workflow's, or that came while
 * the workflow has no token. It is recorded as the workflow's last fire.
 */
export const WORKFLOW_WEBHOOK_TOKEN_MISMATCH_CODE = "workflow.webhook_token_mismatch" as const;
/** The type of {@link WORKFLOW_WEBHOOK_TOKEN_MISMATCH_CODE}. */
export type WorkflowWebhookTokenMismatchCode = typeof WORKFLOW_WEBHOOK_TOKEN_MISMATCH_CODE;

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
  z.object({ definitionId: WorkflowDefinitionIdSchema, updatedAt: isoInstant }).strict();

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

/** The builder's draft id, minted by the daemon on the first save and carried in the address. */
export type WorkflowDraftId = string & { readonly __brand: "WorkflowDraftId" };
/** Wire schema for {@link WorkflowDraftId}. */
export const WorkflowDraftIdSchema: z.ZodType<WorkflowDraftId, WorkflowDraftId> = z
  .string()
  .min(1)
  .brand<"WorkflowDraftId">() as unknown as z.ZodType<WorkflowDraftId, WorkflowDraftId>;

/**
 * The `workflow.draftUpdate` input: the builder's whole unsaved document, which replaces
 * the one held. The first save omits `workflowDraftId` and the reply mints it. A draft
 * of a saved workflow names the definition and the version it was opened from.
 */
export interface WorkflowDraftUpdateRequest {
  workflowDraftId?: WorkflowDraftId | undefined;
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
    workflowDraftId: WorkflowDraftIdSchema.optional(),
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

/** When the daemon stored the draft, under the id the builder's address carries. */
export interface WorkflowDraftUpdateResponse {
  workflowDraftId: WorkflowDraftId;
  updatedAt: string;
}
/** Wire schema for {@link WorkflowDraftUpdateResponse}. */
export const WorkflowDraftUpdateResponseSchema: z.ZodType<WorkflowDraftUpdateResponse> = z
  .object({ workflowDraftId: WorkflowDraftIdSchema, updatedAt: isoInstant })
  .strict();

/** The `workflow.draftRead` input: the draft the builder's address names. */
export interface WorkflowDraftReadRequest {
  workflowDraftId: WorkflowDraftId;
}
/** Wire schema for {@link WorkflowDraftReadRequest}. */
export const WorkflowDraftReadRequestSchema: z.ZodType<
  WorkflowDraftReadRequest,
  WorkflowDraftReadRequest
> = z.object({ workflowDraftId: WorkflowDraftIdSchema }).strict();

/** One held draft. */
export interface WorkflowDraft {
  workflowDraftId: WorkflowDraftId;
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
        workflowDraftId: WorkflowDraftIdSchema,
        definitionId: WorkflowDefinitionIdSchema.optional(),
        basedOnVersionNumber: z.number().int().positive().optional(),
        document: WorkflowDraftDocumentSchema,
        updatedAt: isoInstant,
      })
      .strict()
      .nullable(),
  })
  .strict();

// workflow.expressionPreview

/**
 * The `workflow.expressionPreview` input: one expression of one node, of a saved
 * workflow or of the builder's draft, evaluated in the daemon against an item of the
 * last run. It never resolves a secret: a sensitive field previews the secret's name.
 * An evaluation past its budget is refused with {@link WORKFLOW_EXPRESSION_OVER_BUDGET_CODE}.
 */
export interface WorkflowExpressionPreviewRequest {
  definitionId?: WorkflowDefinitionId | undefined;
  workflowDraftId?: WorkflowDraftId | undefined;
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
    workflowDraftId: WorkflowDraftIdSchema.optional(),
    nodeId: WorkflowNodeIdSchema,
    expression: z.string().min(1),
    itemIndex: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (request) => (request.definitionId === undefined) !== (request.workflowDraftId === undefined),
    {
      message: "A preview names exactly one of a definition or a draft.",
    },
  );

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
      createdAt: isoInstant,
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
      port: z.number().int().min(1).max(65_535),
      state: z.enum(WORKFLOW_WEBHOOK_LISTENER_STATES),
    })
    .strict();
