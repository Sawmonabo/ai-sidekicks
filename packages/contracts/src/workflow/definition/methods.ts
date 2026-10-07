// The `workflow.*` methods over definitions and their versions: create, read, list,
// the version reads, update, delete, export and import, and the difference between two
// versions, with the refusals they answer with. Also the one method table for every
// definition method, including those whose shapes are in `workflow/definition/builder.ts`.
// Nothing here registers a handler.
import { z } from "zod";

import { AgentIdSchema, type AgentId } from "../../agent/definition.js";
import { countSchema, isoDateTimeSchema } from "../../internal/wire-scalars.js";
import {
  defineMethodDescriptors,
  EmptyPayloadSchema,
  type EmptyPayload,
  type MethodDescriptor,
} from "../../method-descriptor.js";
import { PermissionLevelSchema, type PermissionLevel } from "../../session/controls/methods.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "../../free-form-string.js";
import { TagListSchema } from "../../tag.js";
import { WorkflowRunStatusSchema, type WorkflowRunStatus } from "../run/status.js";
import { WorkflowRunIdSchema, type WorkflowRunId } from "../run/id.js";
import {
  WorkflowContentHashSchema,
  WorkflowDefinitionIdSchema,
  WorkflowDocumentSchema,
  WorkflowEdgeSchema,
  WorkflowNodeKindIdSchema,
  WorkflowNodeSchema,
  WorkflowVersionIdSchema,
  type WorkflowDefinitionId,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKindId,
} from "./document.js";
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
  WorkflowPermissionLevelUpdateRequestSchema,
  WorkflowPermissionLevelUpdateResponseSchema,
  WorkflowPinDataSetRequestSchema,
  WorkflowPinDataSetResponseSchema,
  WorkflowTagsSetRequestSchema,
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
  type WorkflowPermissionLevelUpdateRequest,
  type WorkflowPermissionLevelUpdateResponse,
  type WorkflowPinDataSetRequest,
  type WorkflowPinDataSetResponse,
  type WorkflowTagsSetRequest,
  type WorkflowWebhookListenerReadResponse,
  type WorkflowWebhookTokenRotateRequest,
  type WorkflowWebhookTokenRotateResponse,
} from "./builder.js";

// Refusals

/**
 * An update whose expected version is no longer the latest; nothing is written.
 *
 * @consumedBy the handler that returns the `workflow.version_stale` error
 */
export const WORKFLOW_VERSION_STALE_CODE = "workflow.version_stale" as const;

/**
 * An imported file whose schema version this daemon does not know.
 *
 * @consumedBy the handler that returns the `workflow.import_schema_unknown` error
 */
export const WORKFLOW_IMPORT_SCHEMA_UNKNOWN_CODE = "workflow.import_schema_unknown" as const;

// workflow.definitionCreate

/**
 * The `workflow.definitionCreate` input. Saving a new workflow, duplicating one and
 * importing a file all send this one shape. The name is the document's own and is used
 * once across the one library, compared ignoring case by the shared name fold (`foldName`):
 * a name another workflow holds is refused with `workflow.definition_refused`, finding
 * `name_taken`.
 */
export interface WorkflowDefinitionCreateRequest {
  document: WorkflowDocument;
}
/** Wire schema for {@link WorkflowDefinitionCreateRequest}. */
export const WorkflowDefinitionCreateRequestSchema: z.ZodType<
  WorkflowDefinitionCreateRequest,
  WorkflowDefinitionCreateRequest
> = z.object({ document: WorkflowDocumentSchema }).strict();

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
    createdAt: isoDateTimeSchema,
  })
  .strict();

// workflow.definitionRead

/**
 * The `workflow.definitionRead` input: one definition, at `version` when given and at its latest
 * version otherwise. A deleted definition still reads; only one never created is refused
 * `workflow.not_found`.
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

/** What a definition read carries beside the webhook token's dates. */
interface WorkflowDefinitionReadRecord {
  id: WorkflowDefinitionId;
  name: string;
  versionNumber: number;
  workflowVersionId: string;
  contentHash: string;
  document: WorkflowDocument;
  /** The workflow's own level, which every run of it uses and the builder's level pill reads. */
  permissionLevel: PermissionLevel;
  createdAt: string;
  webhookLastFire?: { at: string; outcome: WorkflowWebhookFireOutcome } | undefined;
  /**
   * When the workflow was deleted, absent while it is not. A deleted workflow still reads, so a
   * run filter can name it; the builder opens no deleted workflow.
   */
  deletedAt?: string | undefined;
}

/**
 * The webhook token's dates: when it was made and when a call last presented it, both absent
 * while the workflow has no token, and a last use only beside the token's creation.
 */
type WorkflowWebhookTokenDates =
  | { webhookTokenCreatedAt: string; webhookTokenLastUsedAt?: string | undefined }
  | { webhookTokenCreatedAt?: undefined; webhookTokenLastUsedAt?: undefined };

/**
 * The `workflow.definitionRead` result. The webhook token is never read back, only its hash is
 * kept, so the reply carries the token's dates and the last fire's outcome instead. The tags ride
 * the document.
 */
export type WorkflowDefinitionReadResponse = WorkflowDefinitionReadRecord &
  WorkflowWebhookTokenDates;

const workflowDefinitionReadRecordShape = {
  id: WorkflowDefinitionIdSchema,
  name: z.string().min(1),
  versionNumber: z.number().int().positive(),
  workflowVersionId: WorkflowVersionIdSchema,
  contentHash: WorkflowContentHashSchema,
  document: WorkflowDocumentSchema,
  permissionLevel: PermissionLevelSchema,
  createdAt: isoDateTimeSchema,
  webhookLastFire: z
    .object({ at: isoDateTimeSchema, outcome: z.enum(WORKFLOW_WEBHOOK_FIRE_OUTCOMES) })
    .strict()
    .optional(),
  deletedAt: isoDateTimeSchema.optional(),
};
/** Wire schema for {@link WorkflowDefinitionReadResponse}. */
export const WorkflowDefinitionReadResponseSchema: z.ZodType<WorkflowDefinitionReadResponse> =
  z.union([
    z
      .object({
        ...workflowDefinitionReadRecordShape,
        webhookTokenCreatedAt: isoDateTimeSchema,
        webhookTokenLastUsedAt: isoDateTimeSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...workflowDefinitionReadRecordShape,
        webhookTokenCreatedAt: z.undefined().optional(),
        webhookTokenLastUsedAt: z.undefined().optional(),
      })
      .strict(),
  ]);

// workflow.definitionList

/**
 * The `workflow.definitionList` input: one page of every saved workflow on this machine. The
 * `workflow_list` agent tool takes it as its input, so each member's description is text a model
 * reads.
 */
export interface WorkflowDefinitionListRequest {
  limit?: number | undefined;
  cursor?: string | undefined;
}
/** Wire schema for {@link WorkflowDefinitionListRequest}. */
export const WorkflowDefinitionListRequestSchema: z.ZodType<
  WorkflowDefinitionListRequest,
  WorkflowDefinitionListRequest
> = z
  .object({
    limit: z.number().int().positive().optional().describe("The most workflows to return."),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe("The cursor a previous call returned, to read the next page."),
  })
  .strict();

/**
 * One definition in a list, with what a catalog row shows beside the name, so the table needs no
 * second read per row.
 */
export interface WorkflowDefinitionSummary {
  id: WorkflowDefinitionId;
  name: string;
  /**
   * The latest version's number, which a version read addresses; passed through beside
   * `latestWorkflowVersionId`, never derived from it.
   */
  latestVersionNumber: number;
  /** The latest version's id, which a run start takes. */
  latestWorkflowVersionId: string;
  contentHash: string;
  triggerKind: WorkflowNodeKindId;
  /** The last run's status and start, absent where the workflow never ran, which is no failure. */
  lastRun?:
    | { workflowRunId: WorkflowRunId; status: WorkflowRunStatus; startedAt: string }
    | undefined;
  schedule?: { expression: string; timeZone: string; nextFireAt?: string | undefined } | undefined;
  /**
   * The last fire the trigger's overlap choice skipped because a run was still going, with that
   * run's start; a skipped fire is never a run.
   */
  lastSkippedFire?: { scheduledAt: string; runningSince: string } | undefined;
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
    latestVersionNumber: z.number().int().positive(),
    latestWorkflowVersionId: WorkflowVersionIdSchema,
    contentHash: WorkflowContentHashSchema,
    triggerKind: WorkflowNodeKindIdSchema,
    lastRun: z
      .object({
        workflowRunId: WorkflowRunIdSchema,
        status: WorkflowRunStatusSchema,
        startedAt: isoDateTimeSchema,
      })
      .strict()
      .optional(),
    // Absent where the definition declares no schedule. The next fire is computed in
    // the schedule trigger's own timezone, and absent while the workflow is off.
    schedule: z
      .object({
        expression: z.string().min(1),
        timeZone: z.string().min(1),
        nextFireAt: isoDateTimeSchema.optional(),
      })
      .strict()
      .optional(),
    lastSkippedFire: z
      .object({ scheduledAt: isoDateTimeSchema, runningSince: isoDateTimeSchema })
      .strict()
      .optional(),
    // Whether the workflow's triggers are armed: the toggle's own truth, so the row
    // reverts visibly when the daemon refuses rather than holding an optimistic value.
    enabled: z.boolean(),
    tags: TagListSchema,
    runCount: countSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
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

// workflow.versionRead and workflow.versionChainRead

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
    createdAt: isoDateTimeSchema,
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
const WorkflowVersionChangeCountsSchema: z.ZodType<WorkflowVersionChangeCounts> = z
  .object({
    nodesAdded: countSchema,
    nodesRemoved: countSchema,
    nodesChanged: countSchema,
    edgesAdded: countSchema,
    edgesRemoved: countSchema,
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
    createdAt: isoDateTimeSchema,
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

// workflow.definitionUpdate and workflow.definitionDelete

/**
 * The `workflow.definitionUpdate` input: Save, Restore, and a schedule change. It writes
 * a new version and never changes one, and only when `expectedVersionNumber` is still the latest;
 * otherwise it is refused with {@link WORKFLOW_VERSION_STALE_CODE}. A name another workflow in
 * the one library holds, compared ignoring case by the shared name fold (`foldName`), is refused
 * with `workflow.definition_refused`, finding `name_taken`.
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

/** The `workflow.definitionUpdate` result: the new version of the requested definition. */
export interface WorkflowDefinitionUpdateResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  workflowVersionId: string;
  contentHash: string;
  createdAt: string;
}
/** Wire schema for {@link WorkflowDefinitionUpdateResponse}. */
export const WorkflowDefinitionUpdateResponseSchema: z.ZodType<WorkflowDefinitionUpdateResponse> = z
  .object({
    definitionId: WorkflowDefinitionIdSchema,
    versionNumber: z.number().int().positive(),
    workflowVersionId: WorkflowVersionIdSchema,
    contentHash: WorkflowContentHashSchema,
    createdAt: isoDateTimeSchema,
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
    retainedRunCount: countSchema,
  })
  .strict();

// workflow.definitionExport and workflow.definitionImport

const filePathSchema = wireFreeFormString(FILE_PATH_MAX_LEN, "filePath");

/**
 * The `workflow.definitionExport` input. The daemon writes one version's canonical file,
 * its body and, unless `includeLayout` is false, its layout, with each Code node's
 * package lock. `filePath` is the path main forwards in place of the token the platform's
 * save chooser returned.
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
 * creates the definition through the create path with its whole check, all or nothing, so a
 * name another workflow in the one library holds, compared ignoring case by the shared name fold
 * (`foldName`), is refused with `workflow.definition_refused`, finding `name_taken`. `filePath`
 * is the path main forwards in place of the token the platform's open chooser returned.
 */
export interface WorkflowDefinitionImportRequest {
  filePath: string;
}
/** Wire schema for {@link WorkflowDefinitionImportRequest}. */
export const WorkflowDefinitionImportRequestSchema: z.ZodType<
  WorkflowDefinitionImportRequest,
  WorkflowDefinitionImportRequest
> = z.object({ filePath: filePathSchema }).strict();

// workflow.versionDiffRead

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

// Method descriptors

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
    WorkflowDefinitionCreateResponse
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
  readonly "workflow.tagsSet": MethodDescriptor<
    "workflow.tagsSet",
    WorkflowTagsSetRequest,
    WorkflowDefinitionSettingResponse
  >;
  readonly "workflow.permissionLevelUpdate": MethodDescriptor<
    "workflow.permissionLevelUpdate",
    WorkflowPermissionLevelUpdateRequest,
    WorkflowPermissionLevelUpdateResponse
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
    EmptyPayload,
    WorkflowWebhookListenerReadResponse
  >;
}

/**
 * The `workflow.*` method table over definitions.
 */
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
      responseSchema: WorkflowDefinitionCreateResponseSchema,
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
    "workflow.tagsSet": {
      method: "workflow.tagsSet",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowTagsSetRequestSchema,
      responseSchema: WorkflowDefinitionSettingResponseSchema,
    },
    "workflow.permissionLevelUpdate": {
      method: "workflow.permissionLevelUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowPermissionLevelUpdateRequestSchema,
      responseSchema: WorkflowPermissionLevelUpdateResponseSchema,
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
      requestSchema: EmptyPayloadSchema,
      responseSchema: WorkflowWebhookListenerReadResponseSchema,
    },
  });
