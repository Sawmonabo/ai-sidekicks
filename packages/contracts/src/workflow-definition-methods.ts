// The `workflow.*` methods over definitions and their versions: create, read, list,
// the version reads, update, delete, export and import, and the difference between two
// versions, with the refusals they answer with. Also the one method table for every
// definition method, including those whose shapes are in `workflow-definition-builder.ts`.
// Nothing here registers a handler.
import { z } from "zod";

import { AgentIdSchema, type AgentId } from "./agent-definition.js";
import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { REPO_PATH_MAX_LEN } from "./repo.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";
import {
  WorkflowContentHashSchema,
  WorkflowDefinitionIdSchema,
  WorkflowDefinitionScopeRefSchema,
  WorkflowDefinitionScopeSchema,
  WorkflowDocumentSchema,
  WorkflowEdgeSchema,
  WorkflowNodeKindIdSchema,
  WorkflowNodeSchema,
  WorkflowVersionIdSchema,
  type WorkflowDefinitionId,
  type WorkflowDefinitionScope,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKindId,
} from "./workflow-definition.js";
import {
  WorkflowDefinitionSettingResponseSchema,
  WorkflowDraftReadRequestSchema,
  WorkflowDraftReadResponseSchema,
  WorkflowDraftUpdateRequestSchema,
  WorkflowDraftUpdateResponseSchema,
  WorkflowEnabledSetRequestSchema,
  WorkflowEnabledSetResponseSchema,
  WorkflowExpressionPreviewRequestSchema,
  WorkflowExpressionPreviewResponseSchema,
  WorkflowLayoutSetRequestSchema,
  WorkflowPinDataSetRequestSchema,
  WorkflowPinDataSetResponseSchema,
  WorkflowWebhookListenerReadRequestSchema,
  WorkflowWebhookListenerReadResponseSchema,
  WorkflowWebhookTokenRotateRequestSchema,
  WorkflowWebhookTokenRotateResponseSchema,
  type WorkflowDefinitionSettingResponse,
  type WorkflowDraftReadRequest,
  type WorkflowDraftReadResponse,
  type WorkflowDraftUpdateRequest,
  type WorkflowDraftUpdateResponse,
  type WorkflowEnabledSetRequest,
  type WorkflowEnabledSetResponse,
  type WorkflowExpressionPreviewRequest,
  type WorkflowExpressionPreviewResponse,
  type WorkflowLayoutSetRequest,
  type WorkflowPinDataSetRequest,
  type WorkflowPinDataSetResponse,
  type WorkflowWebhookListenerReadRequest,
  type WorkflowWebhookListenerReadResponse,
  type WorkflowWebhookTokenRotateRequest,
  type WorkflowWebhookTokenRotateResponse,
} from "./workflow-definition-builder.js";

const isoInstant = z.iso.datetime({ offset: true });

// --------------------------------------------------------------------------
// Refusals
// --------------------------------------------------------------------------

/** A `shared` definition saved by someone the daemon's operator check does not admit. */
export const WORKFLOW_OPERATOR_REQUIRED_CODE = "workflow.operator_required" as const;
/** The type of {@link WORKFLOW_OPERATOR_REQUIRED_CODE}. */
export type WorkflowOperatorRequiredCode = typeof WORKFLOW_OPERATOR_REQUIRED_CODE;

/** An update whose expected version is no longer the latest; nothing is written. */
export const WORKFLOW_VERSION_STALE_CODE = "workflow.version_stale" as const;
/** The type of {@link WORKFLOW_VERSION_STALE_CODE}. */
export type WorkflowVersionStaleCode = typeof WORKFLOW_VERSION_STALE_CODE;

/** An imported file whose schema version this daemon does not know. */
export const WORKFLOW_IMPORT_SCHEMA_UNKNOWN_CODE = "workflow.import_schema_unknown" as const;
/** The type of {@link WORKFLOW_IMPORT_SCHEMA_UNKNOWN_CODE}. */
export type WorkflowImportSchemaUnknownCode = typeof WORKFLOW_IMPORT_SCHEMA_UNKNOWN_CODE;

// --------------------------------------------------------------------------
// workflow.definitionCreate
// --------------------------------------------------------------------------

/**
 * The `workflow.definitionCreate` input. Saving a new workflow, duplicating one,
 * importing a file and moving one to `shared` all send this one shape. Authorization
 * keys on `scope`, never on which act composed the request, so the request has no act
 * field. The name is the document's own.
 */
export interface WorkflowDefinitionCreateRequest {
  sessionId: SessionId;
  scope: WorkflowDefinitionScope;
  scopeRef?: string | undefined;
  parentContentHash?: string | undefined;
  document: WorkflowDocument;
}
/** Wire schema for {@link WorkflowDefinitionCreateRequest}. */
export const WorkflowDefinitionCreateRequestSchema: z.ZodType<
  WorkflowDefinitionCreateRequest,
  WorkflowDefinitionCreateRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    // A `shared` target is refused for anyone the daemon's operator check does not
    // admit; it is never quietly narrowed to a smaller scope.
    scope: WorkflowDefinitionScopeSchema,
    // Omitted at `session`, it means this request's session; at `shared`, the empty
    // string. `project` has nothing to derive it from, so omitting it there is refused.
    scopeRef: WorkflowDefinitionScopeRefSchema.optional(),
    // The hash of the `shared` definition this one was branched from when an author
    // edited it. Provenance only: it is outside the hashed body, so a branched definition
    // and one written from scratch with the same body hash alike.
    parentContentHash: WorkflowContentHashSchema.optional(),
    document: WorkflowDocumentSchema,
  })
  .strict();

/**
 * The `workflow.definitionCreate` result: the new definition and its first version,
 * with what a caller needs to pin or start that version without a second read.
 */
export interface WorkflowDefinitionCreateResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  contentHash: string;
  workflowVersionId: string;
  createdAt: string;
}
/** Wire schema for {@link WorkflowDefinitionCreateResponse}. */
export const WorkflowDefinitionCreateResponseSchema: z.ZodType<WorkflowDefinitionCreateResponse> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    versionNumber: z.number().int().positive(),
    contentHash: WorkflowContentHashSchema,
    workflowVersionId: WorkflowVersionIdSchema,
    createdAt: isoInstant,
  })
  .strict();

// --------------------------------------------------------------------------
// workflow.definitionRead
// --------------------------------------------------------------------------

/**
 * The `workflow.definitionRead` input: one definition, at `version` when given and at
 * its latest version otherwise.
 */
export interface WorkflowDefinitionReadRequest {
  definitionId: WorkflowDefinitionId;
  version?: number | undefined;
}
/** Wire schema for {@link WorkflowDefinitionReadRequest}. */
export const WorkflowDefinitionReadRequestSchema: z.ZodType<
  WorkflowDefinitionReadRequest,
  WorkflowDefinitionReadRequest
> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    version: z.number().int().positive().optional(),
  })
  .strict();

const WORKFLOW_WEBHOOK_FIRE_OUTCOMES = ["started", "skipped", "waiting", "token_mismatch"] as const;

/**
 * What a webhook fire came to: a run started, skipped because a run was still going,
 * waiting to run once the going run finishes, or refused for a token that did not match.
 */
export type WorkflowWebhookFireOutcome = (typeof WORKFLOW_WEBHOOK_FIRE_OUTCOMES)[number];

/**
 * The `workflow.definitionRead` result. The webhook token is never read back, only
 * its hash is kept, so the reply carries the token's dates and the last fire's outcome
 * instead: `webhookTokenCreatedAt` is absent while the workflow has no token, and
 * `webhookTokenLastUsedAt` until a call presents it.
 */
export interface WorkflowDefinitionReadResponse {
  id: WorkflowDefinitionId;
  name: string;
  scope: WorkflowDefinitionScope;
  scopeRef: string;
  versionNumber: number;
  workflowVersionId: string;
  contentHash: string;
  document: WorkflowDocument;
  createdAt: string;
  webhookTokenCreatedAt?: string | undefined;
  webhookTokenLastUsedAt?: string | undefined;
  webhookLastFire?: { at: string; outcome: WorkflowWebhookFireOutcome } | undefined;
}
/** Wire schema for {@link WorkflowDefinitionReadResponse}. */
export const WorkflowDefinitionReadResponseSchema: z.ZodType<WorkflowDefinitionReadResponse> = z
  .object({
    id: WorkflowDefinitionIdSchema,
    name: z.string().min(1),
    scope: WorkflowDefinitionScopeSchema,
    scopeRef: WorkflowDefinitionScopeRefSchema,
    versionNumber: z.number().int().positive(),
    workflowVersionId: WorkflowVersionIdSchema,
    contentHash: WorkflowContentHashSchema,
    document: WorkflowDocumentSchema,
    createdAt: isoInstant,
    webhookTokenCreatedAt: isoInstant.optional(),
    webhookTokenLastUsedAt: isoInstant.optional(),
    webhookLastFire: z
      .object({ at: isoInstant, outcome: z.enum(WORKFLOW_WEBHOOK_FIRE_OUTCOMES) })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (reply) =>
      reply.webhookTokenLastUsedAt === undefined || reply.webhookTokenCreatedAt !== undefined,
    { message: "A token's last use is reported only beside the token's creation date." },
  );

// --------------------------------------------------------------------------
// workflow.definitionList
// --------------------------------------------------------------------------

/**
 * The `workflow.definitionList` input. Without `scope` it answers every visible scope
 * together. Without `sessionId` the list is not resolved from any one session, so no
 * entry carries `resolvesAtThisContext`.
 */
export interface WorkflowDefinitionListRequest {
  sessionId?: SessionId | undefined;
  scope?: WorkflowDefinitionScope | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}
/** Wire schema for {@link WorkflowDefinitionListRequest}. */
export const WorkflowDefinitionListRequestSchema: z.ZodType<
  WorkflowDefinitionListRequest,
  WorkflowDefinitionListRequest
> = z
  .object({
    sessionId: SessionIdSchema.optional(),
    scope: WorkflowDefinitionScopeSchema.optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

/**
 * One definition in a list, with what a catalog row shows beside the name, so the table
 * needs no second read per row. `latestWorkflowVersionId` is what a run start takes;
 * `latestVersionNumber` sits beside it because a version read addresses a version by
 * number. A client passes both through and derives neither from the other.
 */
export interface WorkflowDefinitionSummary {
  id: WorkflowDefinitionId;
  name: string;
  scope: WorkflowDefinitionScope;
  scopeRef: string;
  latestVersionNumber: number;
  latestWorkflowVersionId: string;
  contentHash: string;
  resolvesAtThisContext?: boolean | undefined;
  triggerKind: WorkflowNodeKindId;
  schedule?: { expression: string; timeZone: string; nextFireAt?: string | undefined } | undefined;
  enabled: boolean;
  tags: string[];
  runCount: number;
  createdAt: string;
  updatedAt: string;
}
/** Wire schema for {@link WorkflowDefinitionSummary}. */
export const WorkflowDefinitionSummarySchema: z.ZodType<WorkflowDefinitionSummary> = z
  .object({
    id: WorkflowDefinitionIdSchema,
    name: z.string().min(1),
    scope: WorkflowDefinitionScopeSchema,
    scopeRef: WorkflowDefinitionScopeRefSchema,
    latestVersionNumber: z.number().int().positive(),
    latestWorkflowVersionId: WorkflowVersionIdSchema,
    contentHash: WorkflowContentHashSchema,
    // Present only when the request named a session: true for the one entry per name
    // that resolving most specific first would pick there, so a picker shows which
    // definition a run would use instead of working out the order itself.
    resolvesAtThisContext: z.boolean().optional(),
    triggerKind: WorkflowNodeKindIdSchema,
    // Absent where the definition declares no schedule. The next fire is computed in
    // the schedule trigger's own timezone, and absent while the workflow is off.
    schedule: z
      .object({
        expression: z.string().min(1),
        timeZone: z.string().min(1),
        nextFireAt: isoInstant.optional(),
      })
      .strict()
      .optional(),
    // Whether the workflow's triggers are armed: the toggle's own truth, so the row
    // reverts visibly when the daemon refuses rather than holding an optimistic value.
    enabled: z.boolean(),
    tags: z.array(z.string().min(1)),
    runCount: z.number().int().nonnegative(),
    createdAt: isoInstant,
    updatedAt: isoInstant,
  })
  .strict();

/** The `workflow.definitionList` result: one page of definitions, each listed once across pages. */
export interface WorkflowDefinitionListResponse {
  definitions: WorkflowDefinitionSummary[];
  nextCursor?: string | undefined;
}
/** Wire schema for {@link WorkflowDefinitionListResponse}. */
export const WorkflowDefinitionListResponseSchema: z.ZodType<WorkflowDefinitionListResponse> = z
  .object({
    definitions: z.array(WorkflowDefinitionSummarySchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// workflow.versionRead and workflow.versionChainRead
// --------------------------------------------------------------------------

/** The `workflow.versionRead` input: a version is addressed by its definition and number. */
export interface WorkflowVersionReadRequest {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
}
/** Wire schema for {@link WorkflowVersionReadRequest}. */
export const WorkflowVersionReadRequestSchema: z.ZodType<
  WorkflowVersionReadRequest,
  WorkflowVersionReadRequest
> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    versionNumber: z.number().int().positive(),
  })
  .strict();

/**
 * The `workflow.versionRead` result: one saved version, which never changes. A soft-
 * deleted definition's versions still read, because a run pins its version.
 */
export interface WorkflowVersionReadResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  workflowVersionId: string;
  contentHash: string;
  document: WorkflowDocument;
  createdAt: string;
}
/** Wire schema for {@link WorkflowVersionReadResponse}. */
export const WorkflowVersionReadResponseSchema: z.ZodType<WorkflowVersionReadResponse> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    versionNumber: z.number().int().positive(),
    workflowVersionId: WorkflowVersionIdSchema,
    contentHash: WorkflowContentHashSchema,
    document: WorkflowDocumentSchema,
    createdAt: isoInstant,
  })
  .strict();

/**
 * The `workflow.versionChainRead` input, keyed by a version id alone. A run holds only
 * its pinned version id, and a run whose definition was deleted still opens, so this
 * read works from that one handle.
 */
export interface WorkflowVersionChainReadRequest {
  workflowVersionId: string;
}
/** Wire schema for {@link WorkflowVersionChainReadRequest}. */
export const WorkflowVersionChainReadRequestSchema: z.ZodType<
  WorkflowVersionChainReadRequest,
  WorkflowVersionChainReadRequest
> = z.object({ workflowVersionId: WorkflowVersionIdSchema }).strict();

/** Who saved a version: the person, or the agent that did. */
export type WorkflowVersionSavedBy = { kind: "user" } | { kind: "agent"; agentId: AgentId };
const WorkflowVersionSavedBySchema: z.ZodType<WorkflowVersionSavedBy> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("user") }).strict(),
    z.object({ kind: z.literal("agent"), agentId: AgentIdSchema }).strict(),
  ],
);

/**
 * How many nodes and edges one version changed over another, counted over the hashed
 * body only, so a moved node never counts.
 */
export interface WorkflowVersionChangeCounts {
  nodesAdded: number;
  nodesRemoved: number;
  nodesChanged: number;
  edgesAdded: number;
  edgesRemoved: number;
}
const count = z.number().int().nonnegative();
const WorkflowVersionChangeCountsSchema: z.ZodType<WorkflowVersionChangeCounts> = z
  .object({
    nodesAdded: count,
    nodesRemoved: count,
    nodesChanged: count,
    edgesAdded: count,
    edgesRemoved: count,
  })
  .strict();

/**
 * One version in a chain: the id a re-pin carries, the number a person reads, when it
 * was saved and by whom, and what it changed over the version before it (absent on the
 * first version).
 */
export interface WorkflowVersionChainEntry {
  workflowVersionId: string;
  versionNumber: number;
  contentHash: string;
  createdAt: string;
  savedBy: WorkflowVersionSavedBy;
  changesFromPrevious?: WorkflowVersionChangeCounts | undefined;
}
/** Wire schema for {@link WorkflowVersionChainEntry}. */
export const WorkflowVersionChainEntrySchema: z.ZodType<WorkflowVersionChainEntry> = z
  .object({
    workflowVersionId: WorkflowVersionIdSchema,
    versionNumber: z.number().int().positive(),
    contentHash: WorkflowContentHashSchema,
    createdAt: isoInstant,
    savedBy: WorkflowVersionSavedBySchema,
    changesFromPrevious: WorkflowVersionChangeCountsSchema.optional(),
  })
  .strict();

/**
 * The `workflow.versionChainRead` result: every version of the pinned version's
 * definition, oldest first.
 */
export interface WorkflowVersionChainReadResponse {
  definitionId: WorkflowDefinitionId;
  versions: WorkflowVersionChainEntry[];
}
/** Wire schema for {@link WorkflowVersionChainReadResponse}. */
export const WorkflowVersionChainReadResponseSchema: z.ZodType<WorkflowVersionChainReadResponse> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    versions: z.array(WorkflowVersionChainEntrySchema).min(1),
  })
  .strict();

// --------------------------------------------------------------------------
// workflow.definitionUpdate and workflow.definitionDelete
// --------------------------------------------------------------------------

/**
 * The `workflow.definitionUpdate` input: Save, Restore, and a schedule change. It writes
 * a new version and never changes one, and only when `expectedVersionNumber` is still
 * the latest; otherwise it is refused with {@link WORKFLOW_VERSION_STALE_CODE}.
 */
export interface WorkflowDefinitionUpdateRequest {
  definitionId: WorkflowDefinitionId;
  expectedVersionNumber: number;
  document: WorkflowDocument;
}
/** Wire schema for {@link WorkflowDefinitionUpdateRequest}. */
export const WorkflowDefinitionUpdateRequestSchema: z.ZodType<
  WorkflowDefinitionUpdateRequest,
  WorkflowDefinitionUpdateRequest
> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    expectedVersionNumber: z.number().int().positive(),
    document: WorkflowDocumentSchema,
  })
  .strict();

/**
 * The `workflow.definitionUpdate` result. An edit to a `shared` definition leaves it
 * untouched and branches a new definition carrying the original's hash as its parent,
 * so `definitionId` can name a different definition from the request's, and
 * `branchedFromContentHash` is present exactly then.
 */
export interface WorkflowDefinitionUpdateResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  workflowVersionId: string;
  contentHash: string;
  branchedFromContentHash?: string | undefined;
  createdAt: string;
}
/** Wire schema for {@link WorkflowDefinitionUpdateResponse}. */
export const WorkflowDefinitionUpdateResponseSchema: z.ZodType<WorkflowDefinitionUpdateResponse> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    versionNumber: z.number().int().positive(),
    workflowVersionId: WorkflowVersionIdSchema,
    contentHash: WorkflowContentHashSchema,
    branchedFromContentHash: WorkflowContentHashSchema.optional(),
    createdAt: isoInstant,
  })
  .strict();

/** The `workflow.definitionDelete` input. */
export interface WorkflowDefinitionDeleteRequest {
  definitionId: WorkflowDefinitionId;
}
/** Wire schema for {@link WorkflowDefinitionDeleteRequest}. */
export const WorkflowDefinitionDeleteRequestSchema: z.ZodType<
  WorkflowDefinitionDeleteRequest,
  WorkflowDefinitionDeleteRequest
> = z.object({ definitionId: WorkflowDefinitionIdSchema }).strict();

/**
 * The `workflow.definitionDelete` result. The delete is soft: the runs that pinned the
 * definition's versions stay readable, and the reply counts them.
 */
export interface WorkflowDefinitionDeleteResponse {
  definitionId: WorkflowDefinitionId;
  deleted: true;
  retainedRunCount: number;
}
/** Wire schema for {@link WorkflowDefinitionDeleteResponse}. */
export const WorkflowDefinitionDeleteResponseSchema: z.ZodType<WorkflowDefinitionDeleteResponse> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    deleted: z.literal(true),
    retainedRunCount: count,
  })
  .strict();

// --------------------------------------------------------------------------
// workflow.definitionExport and workflow.definitionImport
// --------------------------------------------------------------------------

const filePathSchema = wireFreeFormString(REPO_PATH_MAX_LEN, "filePath");

/**
 * The `workflow.definitionExport` input. The daemon writes one version's canonical file,
 * its body and, unless `includeLayout` is false, its layout, with each Code node's
 * package lock. `filePath` is the path main's relay put in place of the token the
 * platform's save chooser returned.
 */
export interface WorkflowDefinitionExportRequest {
  definitionId: WorkflowDefinitionId;
  version?: number | undefined;
  includeLayout?: boolean | undefined;
  filePath: string;
}
/** Wire schema for {@link WorkflowDefinitionExportRequest}. */
export const WorkflowDefinitionExportRequestSchema: z.ZodType<
  WorkflowDefinitionExportRequest,
  WorkflowDefinitionExportRequest
> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    version: z.number().int().positive().optional(),
    includeLayout: z.boolean().optional(),
    filePath: filePathSchema,
  })
  .strict();

/** The `workflow.definitionExport` result: the version written and its content hash. */
export interface WorkflowDefinitionExportResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  contentHash: string;
}
/** Wire schema for {@link WorkflowDefinitionExportResponse}. */
export const WorkflowDefinitionExportResponseSchema: z.ZodType<WorkflowDefinitionExportResponse> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    versionNumber: z.number().int().positive(),
    contentHash: WorkflowContentHashSchema,
  })
  .strict();

/**
 * The `workflow.definitionImport` input. The daemon reads the file the person picked and
 * creates the definition through the create path with its whole check, all or nothing;
 * the file carries no scope, so the caller names where it lands. `filePath` is the path
 * main's relay put in place of the token the platform's open chooser returned.
 */
export interface WorkflowDefinitionImportRequest {
  sessionId: SessionId;
  filePath: string;
  scope: WorkflowDefinitionScope;
  scopeRef?: string | undefined;
}
/** Wire schema for {@link WorkflowDefinitionImportRequest}. */
export const WorkflowDefinitionImportRequestSchema: z.ZodType<
  WorkflowDefinitionImportRequest,
  WorkflowDefinitionImportRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    filePath: filePathSchema,
    scope: WorkflowDefinitionScopeSchema,
    scopeRef: WorkflowDefinitionScopeRefSchema.optional(),
  })
  .strict();

/** The `workflow.definitionImport` result: the created definition, as a create answers. */
export type WorkflowDefinitionImportResponse = WorkflowDefinitionCreateResponse;
/** Wire schema for {@link WorkflowDefinitionImportResponse}. */
export const WorkflowDefinitionImportResponseSchema: z.ZodType<WorkflowDefinitionImportResponse> =
  WorkflowDefinitionCreateResponseSchema;

// --------------------------------------------------------------------------
// workflow.versionDiffRead
// --------------------------------------------------------------------------

/** The `workflow.versionDiffRead` input: two versions of one workflow. */
export interface WorkflowVersionDiffReadRequest {
  fromWorkflowVersionId: string;
  toWorkflowVersionId: string;
}
/** Wire schema for {@link WorkflowVersionDiffReadRequest}. */
export const WorkflowVersionDiffReadRequestSchema: z.ZodType<
  WorkflowVersionDiffReadRequest,
  WorkflowVersionDiffReadRequest
> = z
  .object({
    fromWorkflowVersionId: WorkflowVersionIdSchema,
    toWorkflowVersionId: WorkflowVersionIdSchema,
  })
  .strict();

/**
 * The `workflow.versionDiffRead` result: the structural difference, computed in the
 * daemon over the hashed body only, so a moved node is never a change. A changed node
 * carries its params before and after; the trigger counts as a node.
 */
export interface WorkflowVersionDiffReadResponse {
  nodesAdded: WorkflowNode[];
  nodesRemoved: WorkflowNode[];
  nodesChanged: { before: WorkflowNode; after: WorkflowNode }[];
  edgesAdded: WorkflowEdge[];
  edgesRemoved: WorkflowEdge[];
}
/** Wire schema for {@link WorkflowVersionDiffReadResponse}. */
export const WorkflowVersionDiffReadResponseSchema: z.ZodType<WorkflowVersionDiffReadResponse> = z
  .object({
    nodesAdded: z.array(WorkflowNodeSchema),
    nodesRemoved: z.array(WorkflowNodeSchema),
    nodesChanged: z.array(
      z.object({ before: WorkflowNodeSchema, after: WorkflowNodeSchema }).strict(),
    ),
    edgesAdded: z.array(WorkflowEdgeSchema),
    edgesRemoved: z.array(WorkflowEdgeSchema),
  })
  .strict();

// --------------------------------------------------------------------------
// Method descriptors
// --------------------------------------------------------------------------

/** The `workflow.*` methods over definitions, keyed by name. */
export interface WorkflowDefinitionMethodDescriptors {
  readonly "workflow.definitionCreate": MethodDescriptor<
    "workflow.definitionCreate",
    WorkflowDefinitionCreateRequest,
    WorkflowDefinitionCreateResponse
  >;
  readonly "workflow.definitionRead": MethodDescriptor<
    "workflow.definitionRead",
    WorkflowDefinitionReadRequest,
    WorkflowDefinitionReadResponse
  >;
  readonly "workflow.definitionList": MethodDescriptor<
    "workflow.definitionList",
    WorkflowDefinitionListRequest,
    WorkflowDefinitionListResponse
  >;
  readonly "workflow.versionRead": MethodDescriptor<
    "workflow.versionRead",
    WorkflowVersionReadRequest,
    WorkflowVersionReadResponse
  >;
  readonly "workflow.versionChainRead": MethodDescriptor<
    "workflow.versionChainRead",
    WorkflowVersionChainReadRequest,
    WorkflowVersionChainReadResponse
  >;
  readonly "workflow.definitionUpdate": MethodDescriptor<
    "workflow.definitionUpdate",
    WorkflowDefinitionUpdateRequest,
    WorkflowDefinitionUpdateResponse
  >;
  readonly "workflow.definitionDelete": MethodDescriptor<
    "workflow.definitionDelete",
    WorkflowDefinitionDeleteRequest,
    WorkflowDefinitionDeleteResponse
  >;
  readonly "workflow.definitionExport": MethodDescriptor<
    "workflow.definitionExport",
    WorkflowDefinitionExportRequest,
    WorkflowDefinitionExportResponse
  >;
  readonly "workflow.definitionImport": MethodDescriptor<
    "workflow.definitionImport",
    WorkflowDefinitionImportRequest,
    WorkflowDefinitionImportResponse
  >;
  readonly "workflow.enabledSet": MethodDescriptor<
    "workflow.enabledSet",
    WorkflowEnabledSetRequest,
    WorkflowEnabledSetResponse
  >;
  readonly "workflow.layoutSet": MethodDescriptor<
    "workflow.layoutSet",
    WorkflowLayoutSetRequest,
    WorkflowDefinitionSettingResponse
  >;
  readonly "workflow.pinDataSet": MethodDescriptor<
    "workflow.pinDataSet",
    WorkflowPinDataSetRequest,
    WorkflowPinDataSetResponse
  >;
  readonly "workflow.draftUpdate": MethodDescriptor<
    "workflow.draftUpdate",
    WorkflowDraftUpdateRequest,
    WorkflowDraftUpdateResponse
  >;
  readonly "workflow.draftRead": MethodDescriptor<
    "workflow.draftRead",
    WorkflowDraftReadRequest,
    WorkflowDraftReadResponse
  >;
  readonly "workflow.expressionPreview": MethodDescriptor<
    "workflow.expressionPreview",
    WorkflowExpressionPreviewRequest,
    WorkflowExpressionPreviewResponse
  >;
  readonly "workflow.versionDiffRead": MethodDescriptor<
    "workflow.versionDiffRead",
    WorkflowVersionDiffReadRequest,
    WorkflowVersionDiffReadResponse
  >;
  readonly "workflow.webhookTokenRotate": MethodDescriptor<
    "workflow.webhookTokenRotate",
    WorkflowWebhookTokenRotateRequest,
    WorkflowWebhookTokenRotateResponse
  >;
  readonly "workflow.webhookListenerRead": MethodDescriptor<
    "workflow.webhookListenerRead",
    WorkflowWebhookListenerReadRequest,
    WorkflowWebhookListenerReadResponse
  >;
}

/** The `workflow.*` method table over definitions. */
export const WORKFLOW_DEFINITION_METHOD_DESCRIPTORS: WorkflowDefinitionMethodDescriptors =
  defineMethodDescriptors({
    "workflow.definitionCreate": {
      method: "workflow.definitionCreate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowDefinitionCreateRequestSchema,
      responseSchema: WorkflowDefinitionCreateResponseSchema,
    },
    "workflow.definitionRead": {
      method: "workflow.definitionRead",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowDefinitionReadRequestSchema,
      responseSchema: WorkflowDefinitionReadResponseSchema,
    },
    "workflow.definitionList": {
      method: "workflow.definitionList",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowDefinitionListRequestSchema,
      responseSchema: WorkflowDefinitionListResponseSchema,
    },
    "workflow.versionRead": {
      method: "workflow.versionRead",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowVersionReadRequestSchema,
      responseSchema: WorkflowVersionReadResponseSchema,
    },
    "workflow.versionChainRead": {
      method: "workflow.versionChainRead",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowVersionChainReadRequestSchema,
      responseSchema: WorkflowVersionChainReadResponseSchema,
    },
    "workflow.definitionUpdate": {
      method: "workflow.definitionUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowDefinitionUpdateRequestSchema,
      responseSchema: WorkflowDefinitionUpdateResponseSchema,
    },
    "workflow.definitionDelete": {
      method: "workflow.definitionDelete",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowDefinitionDeleteRequestSchema,
      responseSchema: WorkflowDefinitionDeleteResponseSchema,
    },
    "workflow.definitionExport": {
      method: "workflow.definitionExport",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowDefinitionExportRequestSchema,
      responseSchema: WorkflowDefinitionExportResponseSchema,
    },
    "workflow.definitionImport": {
      method: "workflow.definitionImport",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowDefinitionImportRequestSchema,
      responseSchema: WorkflowDefinitionImportResponseSchema,
    },
    "workflow.enabledSet": {
      method: "workflow.enabledSet",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowEnabledSetRequestSchema,
      responseSchema: WorkflowEnabledSetResponseSchema,
    },
    "workflow.layoutSet": {
      method: "workflow.layoutSet",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowLayoutSetRequestSchema,
      responseSchema: WorkflowDefinitionSettingResponseSchema,
    },
    "workflow.pinDataSet": {
      method: "workflow.pinDataSet",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowPinDataSetRequestSchema,
      responseSchema: WorkflowPinDataSetResponseSchema,
    },
    "workflow.draftUpdate": {
      method: "workflow.draftUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowDraftUpdateRequestSchema,
      responseSchema: WorkflowDraftUpdateResponseSchema,
    },
    "workflow.draftRead": {
      method: "workflow.draftRead",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowDraftReadRequestSchema,
      responseSchema: WorkflowDraftReadResponseSchema,
    },
    "workflow.expressionPreview": {
      method: "workflow.expressionPreview",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowExpressionPreviewRequestSchema,
      responseSchema: WorkflowExpressionPreviewResponseSchema,
    },
    "workflow.versionDiffRead": {
      method: "workflow.versionDiffRead",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowVersionDiffReadRequestSchema,
      responseSchema: WorkflowVersionDiffReadResponseSchema,
    },
    "workflow.webhookTokenRotate": {
      method: "workflow.webhookTokenRotate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowWebhookTokenRotateRequestSchema,
      responseSchema: WorkflowWebhookTokenRotateResponseSchema,
    },
    "workflow.webhookListenerRead": {
      method: "workflow.webhookListenerRead",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowWebhookListenerReadRequestSchema,
      responseSchema: WorkflowWebhookListenerReadResponseSchema,
    },
  });
