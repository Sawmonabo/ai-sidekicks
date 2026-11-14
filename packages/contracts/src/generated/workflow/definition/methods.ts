// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `workflow.*` methods over definitions: create, read, list, update, delete, export and import, and the one method table for every definition method.

import {
  type CompiledSchemaCheck,
  type SchemaCheck,
  deepEqual,
  ucs2length,
} from "../../../schema-check.js";
import { type WireInstant, validateWireInstant } from "../../internal/wire-scalars.js";
import { type EmptyPayload, validateEmptyPayload } from "../../method-descriptor.js";
import { type ProviderId, validateProviderId } from "../../provider/id.js";
import { type PermissionLevel, validatePermissionLevel } from "../../session/controls/methods.js";
import { type TagList, validateTagList } from "../../tag.js";
import { type WorkflowRunId, validateWorkflowRunId } from "../run/id.js";
import { type WorkflowRunStatus, validateWorkflowRunStatus } from "../run/status.js";
import {
  type WorkflowBackgroundBrowser,
  type WorkflowBackgroundBrowserUpdateRequest,
  type WorkflowBackgroundBrowserUpdateResponse,
  type WorkflowDefinitionSettingResponse,
  type WorkflowDraftReadRequest,
  type WorkflowDraftReadResponse,
  type WorkflowDraftUpdateRequest,
  type WorkflowDraftUpdateResponse,
  type WorkflowEnabledUpdateRequest,
  type WorkflowEnabledUpdateResponse,
  type WorkflowExpressionPreviewRequest,
  type WorkflowExpressionPreviewResponse,
  type WorkflowLayoutUpdateRequest,
  type WorkflowPermissionLevelUpdateRequest,
  type WorkflowPermissionLevelUpdateResponse,
  type WorkflowPinDataUpdateRequest,
  type WorkflowPinDataUpdateResponse,
  type WorkflowProviderUpdateRequest,
  type WorkflowProviderUpdateResponse,
  type WorkflowTagsUpdateRequest,
  type WorkflowWebhookListenerReadResponse,
  type WorkflowWebhookTokenRotateRequest,
  type WorkflowWebhookTokenRotateResponse,
  validateWorkflowBackgroundBrowser,
  validateWorkflowBackgroundBrowserUpdateRequest,
  validateWorkflowBackgroundBrowserUpdateResponse,
  validateWorkflowDefinitionSettingResponse,
  validateWorkflowDraftReadRequest,
  validateWorkflowDraftReadResponse,
  validateWorkflowDraftUpdateRequest,
  validateWorkflowDraftUpdateResponse,
  validateWorkflowEnabledUpdateRequest,
  validateWorkflowEnabledUpdateResponse,
  validateWorkflowExpressionPreviewRequest,
  validateWorkflowExpressionPreviewResponse,
  validateWorkflowLayoutUpdateRequest,
  validateWorkflowPermissionLevelUpdateRequest,
  validateWorkflowPermissionLevelUpdateResponse,
  validateWorkflowPinDataUpdateRequest,
  validateWorkflowPinDataUpdateResponse,
  validateWorkflowProviderUpdateRequest,
  validateWorkflowProviderUpdateResponse,
  validateWorkflowTagsUpdateRequest,
  validateWorkflowWebhookListenerReadResponse,
  validateWorkflowWebhookTokenRotateRequest,
  validateWorkflowWebhookTokenRotateResponse,
} from "./builder.js";
import {
  type WorkflowContentHash,
  type WorkflowDefinitionId,
  type WorkflowDocument,
  type WorkflowNodeKindId,
  type WorkflowVersionId,
  validateWorkflowContentHash,
  validateWorkflowDefinitionId,
  validateWorkflowDocument,
  validateWorkflowNodeKindId,
  validateWorkflowVersionId,
} from "./document.js";
import {
  type WorkflowVersionDiffReadRequest,
  type WorkflowVersionDiffReadResponse,
  type WorkflowVersionListRequest,
  type WorkflowVersionListResponse,
  type WorkflowVersionReadRequest,
  type WorkflowVersionReadResponse,
  validateWorkflowVersionDiffReadRequest,
  validateWorkflowVersionDiffReadResponse,
  validateWorkflowVersionListRequest,
  validateWorkflowVersionListResponse,
  validateWorkflowVersionReadRequest,
  validateWorkflowVersionReadResponse,
} from "./versions.js";

/**
 * Where a create comes from, tagged on `kind`: a Save of the editor's new workflow, which clears
 * the new-workflow draft in the same write; a file import; or a Duplicate of a saved version.
 */
export type WorkflowCreateOrigin =
  | {
      kind: "newWorkflowDraft";
    }
  | {
      kind: "fileImport";
    }
  | {
      kind: "duplicate";
      /**
       * The version copied; the document is that version's, under its own name.
       */
      copiedVersionId: WorkflowVersionId;
    };
/**
 * What a webhook fire came to: a run started, skipped because a run was still going, waiting to
 * run once the going run finishes, or refused for a token that did not match.
 */
export type WorkflowWebhookFireOutcome = "started" | "skipped" | "waiting" | "tokenMismatch";
/**
 * The `workflow.definition.read` result, its tags riding the document. The webhook token is never
 * read back, only its hash is kept, so the reply carries the token's dates and the last fire's
 * outcome, a last use only beside the token's creation.
 */
export type WorkflowDefinitionReadResponse =
  | WorkflowDefinitionReadWithWebhookToken
  | WorkflowDefinitionReadWithoutWebhookToken;
/**
 * Where the next `workflow.definition.list` page starts, written by the daemon and passed back
 * unchanged. One the daemon did not write is refused as `workflow.cursorUnresolvable`.
 */
export type WorkflowDefinitionListCursor = string & {
  readonly __brand: "WorkflowDefinitionListCursor";
};

/**
 * The `workflow.definition.create` input, which saving a new workflow, duplicating one and
 * importing a file all send, told apart by `origin`. A name another workflow holds, compared
 * ignoring case, is refused with `workflow.definition.refused`, finding `nameTaken`.
 */
export interface WorkflowDefinitionCreateRequest {
  /**
   * The document.
   */
  document: WorkflowDocument;
  /**
   * Where the create comes from.
   */
  origin: WorkflowCreateOrigin;
}
/**
 * The `workflow.definition.create` result: the new definition and its first version, with what a
 * caller needs to pin or start that version without a second read.
 */
export interface WorkflowDefinitionCreateResponse {
  /**
   * The new workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * Its first version's number.
   */
  versionNumber: number;
  /**
   * The hash of that version's hashed body.
   */
  contentHash: WorkflowContentHash;
  /**
   * That version's id, the one a run start takes.
   */
  workflowVersionId: WorkflowVersionId;
  /**
   * When it was saved.
   */
  createdAt: WireInstant;
}
/**
 * The `workflow.definition.read` input: one definition, at `version` when given and at its latest
 * version otherwise. A deleted definition still reads; only one never created is refused
 * `workflow.definition.notFound`.
 */
export interface WorkflowDefinitionReadRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version's number; absent for the latest.
   */
  version?: number;
}
/**
 * The last call to a workflow's webhook address and what became of it.
 */
export interface WorkflowWebhookLastFire {
  /**
   * When the call came.
   */
  at: WireInstant;
  /**
   * What became of it.
   */
  outcome: WorkflowWebhookFireOutcome;
}
/**
 * A definition read of a workflow that holds a webhook token: when it was made, and when a
 * call last presented it.
 */
export interface WorkflowDefinitionReadWithWebhookToken {
  /**
   * The workflow.
   */
  id: WorkflowDefinitionId;
  /**
   * Its name.
   */
  name: string;
  /**
   * The version read's number.
   */
  versionNumber: number;
  /**
   * The version read's id, the one a run start takes.
   */
  workflowVersionId: WorkflowVersionId;
  /**
   * The hash of that version's hashed body.
   */
  contentHash: WorkflowContentHash;
  /**
   * That version's document.
   */
  document: WorkflowDocument;
  /**
   * The workflow's own level, which every run of it uses and the builder's level pill
   * reads.
   */
  permissionLevel: PermissionLevel;
  /**
   * The browser the workflow's runs use in the background, which the builder's browser
   * pill reads; a new workflow reads `settingsDefault`.
   */
  backgroundBrowser: WorkflowBackgroundBrowser;
  /**
   * The provider whose sandbox and shell the workflow's command steps run in; absent
   * until one is chosen.
   */
  provider?: ProviderId;
  /**
   * When the workflow was made.
   */
  createdAt: WireInstant;
  /**
   * The last call to the workflow's webhook address and what became of it.
   */
  webhookLastFire?: WorkflowWebhookLastFire;
  /**
   * When the workflow was deleted, absent while it is not. A deleted workflow still
   * reads, so a run filter can name it; the builder opens no deleted workflow.
   */
  deletedAt?: WireInstant;
  /**
   * When the webhook token was made.
   */
  webhookTokenCreatedAt: WireInstant;
  /**
   * When a call last presented the token; absent until one has.
   */
  webhookTokenLastUsedAt?: WireInstant;
}
/**
 * A definition read of a workflow that holds no webhook token, so no call to its address is
 * taken.
 */
export interface WorkflowDefinitionReadWithoutWebhookToken {
  /**
   * The workflow.
   */
  id: WorkflowDefinitionId;
  /**
   * Its name.
   */
  name: string;
  /**
   * The version read's number.
   */
  versionNumber: number;
  /**
   * The version read's id, the one a run start takes.
   */
  workflowVersionId: WorkflowVersionId;
  /**
   * The hash of that version's hashed body.
   */
  contentHash: WorkflowContentHash;
  /**
   * That version's document.
   */
  document: WorkflowDocument;
  /**
   * The workflow's own level, which every run of it uses and the builder's level pill
   * reads.
   */
  permissionLevel: PermissionLevel;
  /**
   * The browser the workflow's runs use in the background, which the builder's browser
   * pill reads; a new workflow reads `settingsDefault`.
   */
  backgroundBrowser: WorkflowBackgroundBrowser;
  /**
   * The provider whose sandbox and shell the workflow's command steps run in; absent
   * until one is chosen.
   */
  provider?: ProviderId;
  /**
   * When the workflow was made.
   */
  createdAt: WireInstant;
  /**
   * The last call to the workflow's webhook address and what became of it.
   */
  webhookLastFire?: WorkflowWebhookLastFire;
  /**
   * When the workflow was deleted, absent while it is not. A deleted workflow still
   * reads, so a run filter can name it; the builder opens no deleted workflow.
   */
  deletedAt?: WireInstant;
  /**
   * Never present: there is no token.
   */
  webhookTokenCreatedAt?: never;
  /**
   * Never present: there is no token.
   */
  webhookTokenLastUsedAt?: never;
}
/**
 * The `workflow.definition.list` input: one page of every saved workflow on this machine. The
 * `workflow_list` agent tool takes it as its input, so each member's description is text a model
 * reads.
 */
export interface WorkflowDefinitionListRequest {
  /**
   * The most workflows to return.
   */
  limit?: number;
  /**
   * The cursor a previous call returned, to read the next page.
   */
  cursor?: WorkflowDefinitionListCursor;
}
/**
 * A workflow's last run: its status and start.
 */
export interface WorkflowDefinitionLastRun {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * Its status.
   */
  status: WorkflowRunStatus;
  /**
   * When it started.
   */
  startedAt: WireInstant;
}
/**
 * A workflow's schedule in words, with its next fire computed in the schedule trigger's own time
 * zone.
 */
export interface WorkflowDefinitionSchedule {
  /**
   * The schedule's expression.
   */
  expression: string;
  /**
   * The time zone it fires in.
   */
  timeZone: string;
  /**
   * The next fire; absent while the workflow is off.
   */
  nextFireAt?: WireInstant;
}
/**
 * A fire the trigger's overlap choice skipped because a run was still going, with that run's
 * start; a skipped fire is never a run.
 */
export interface WorkflowSkippedFire {
  /**
   * The occurrence that was skipped.
   */
  scheduledAt: WireInstant;
  /**
   * When the run still going had started.
   */
  runningSince: WireInstant;
}
/**
 * One definition in a list, with what a catalog row shows beside the name, so the table needs no
 * second read per row.
 */
export interface WorkflowDefinitionSummary {
  /**
   * The workflow.
   */
  id: WorkflowDefinitionId;
  /**
   * Its name.
   */
  name: string;
  /**
   * The latest version's number, which a version read addresses; passed through beside
   * `latestWorkflowVersionId`, never derived from it.
   */
  latestVersionNumber: number;
  /**
   * The latest version's id, which a run start takes.
   */
  latestWorkflowVersionId: WorkflowVersionId;
  /**
   * The hash of the latest version's hashed body.
   */
  contentHash: WorkflowContentHash;
  /**
   * The kind of the document's one trigger.
   */
  triggerKind: WorkflowNodeKindId;
  /**
   * The last run; absent where the workflow never ran, which is no failure.
   */
  lastRun?: WorkflowDefinitionLastRun;
  /**
   * The schedule; absent where the workflow declares none.
   */
  schedule?: WorkflowDefinitionSchedule;
  /**
   * The last fire the trigger's overlap choice skipped.
   */
  lastSkippedFire?: WorkflowSkippedFire;
  /**
   * Whether the workflow's triggers are armed: the toggle's own truth, so the row reverts
   * visibly when the daemon refuses rather than holding an optimistic value.
   */
  enabled: boolean;
  /**
   * The workflow's tags.
   */
  tags: TagList;
  /**
   * How many runs it has.
   */
  runCount: number;
  /**
   * When it was made.
   */
  createdAt: WireInstant;
  /**
   * When it last changed.
   */
  updatedAt: WireInstant;
}
/**
 * The `workflow.definition.list` result: one page of definitions, each listed once across pages.
 */
export interface WorkflowDefinitionListResponse {
  /**
   * The page.
   */
  definitions: WorkflowDefinitionSummary[];
  /**
   * Where the next page starts; absent on the last.
   */
  nextCursor?: WorkflowDefinitionListCursor;
}
/**
 * The `workflow.definition.update` input (Save, Restore, a schedule change): it writes a new
 * version only while `expectedVersionNumber` is the latest, else refuses `workflow.version.stale`,
 * and a document identical to the latest writes none and answers with that version. A Restore
 * names the version it repeats in `restoredVersionNumber`, whose package locks it keeps, and a
 * name another workflow holds, compared ignoring case, is refused with
 * `workflow.definition.refused`, finding `nameTaken`.
 */
export interface WorkflowDefinitionUpdateRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version the author loaded, which must still be the latest.
   */
  expectedVersionNumber: number;
  /**
   * The document.
   */
  document: WorkflowDocument;
  /**
   * On a Restore, the older version the document repeats.
   */
  restoredVersionNumber?: number;
}
/**
 * The `workflow.definition.update` result: the new version of the requested definition, or its
 * latest where the document was identical to it.
 */
export interface WorkflowDefinitionUpdateResponse {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version's number.
   */
  versionNumber: number;
  /**
   * The version's id, the one a run start takes.
   */
  workflowVersionId: WorkflowVersionId;
  /**
   * The hash of its hashed body.
   */
  contentHash: WorkflowContentHash;
  /**
   * When it was saved.
   */
  createdAt: WireInstant;
}
/**
 * The `workflow.definition.delete` input.
 */
export interface WorkflowDefinitionDeleteRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
}
/**
 * The `workflow.definition.delete` result. The delete is soft: the runs that pinned the
 * definition's versions stay readable, and the reply counts them.
 */
export interface WorkflowDefinitionDeleteResponse {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * Always `true`.
   */
  deleted: true;
  /**
   * How many runs stay readable.
   */
  retainedRunCount: number;
}
/**
 * The `workflow.definition.export` input: the daemon writes one version's canonical file, its body
 * and, unless `includeLayout` is false, its layout, with each Code node's package lock. `filePath`
 * is the path main forwards in place of the token the platform's save chooser returned.
 */
export interface WorkflowDefinitionExportRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version's number; absent for the latest.
   */
  version?: number;
  /**
   * Whether the file carries the layout section; absent, it does.
   */
  includeLayout?: boolean;
  /**
   * The file to write, the path main's relay put in place of the save chooser's token.
   */
  filePath: string;
}
/**
 * The `workflow.definition.export` result: the version written and its content hash.
 */
export interface WorkflowDefinitionExportResponse {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version's number.
   */
  versionNumber: number;
  /**
   * The hash of its hashed body.
   */
  contentHash: WorkflowContentHash;
}
/**
 * The `workflow.definition.import` input: the daemon reads the picked file at `filePath` (main
 * forwards it in place of the open chooser's token) and creates the definition through the create
 * path, all or nothing. A name another workflow holds, compared ignoring case, is refused with
 * `workflow.definition.refused`, finding `nameTaken`, and an unknown schema version with
 * `workflow.definition.importSchemaUnknown`.
 */
export interface WorkflowDefinitionImportRequest {
  /**
   * The file to read.
   */
  filePath: string;
}

/** Checks that a value is a {@link WorkflowCreateOrigin}. */
// prettier-ignore
export const validateWorkflowCreateOrigin: CompiledSchemaCheck<WorkflowCreateOrigin> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowCreateOrigin {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowCreateOrigin.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "newWorkflowDraft"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.kind === undefined) && (missing0 = "kind")){validateWorkflowCreateOrigin.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(key0 === "kind")){validateWorkflowCreateOrigin.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;if(typeof data0 !== "string"){validateWorkflowCreateOrigin.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("newWorkflowDraft" !== data0){validateWorkflowCreateOrigin.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "newWorkflowDraft"}}];return false;}}}}}else {validateWorkflowCreateOrigin.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "fileImport"){const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.kind === undefined) && (missing1 = "kind")){validateWorkflowCreateOrigin.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data){if(!(key1 === "kind")){validateWorkflowCreateOrigin.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data.kind !== undefined){let data1: any = data.kind;if(typeof data1 !== "string"){validateWorkflowCreateOrigin.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("fileImport" !== data1){validateWorkflowCreateOrigin.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "fileImport"}}];return false;}}}}}else {validateWorkflowCreateOrigin.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs7 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "duplicate"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.kind === undefined) && (missing2 = "kind")) || ((data.copiedVersionId === undefined) && (missing2 = "copiedVersionId"))){validateWorkflowCreateOrigin.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!((key2 === "kind") || (key2 === "copiedVersionId"))){validateWorkflowCreateOrigin.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs15: any = errors;if(typeof data2 !== "string"){validateWorkflowCreateOrigin.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("duplicate" !== data2){validateWorkflowCreateOrigin.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "duplicate"}}];return false;}var valid6: any = _errs15 === errors;}else {var valid6: any = true;}if(valid6){if(data.copiedVersionId !== undefined){const _errs17: any = errors;if(!(validateWorkflowVersionId.call(this, data.copiedVersionId, {instancePath:instancePath+"/copiedVersionId",parentData:data,parentDataProperty:"copiedVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid6: any = _errs17 === errors;}else {var valid6: any = true;}}}}}else {validateWorkflowCreateOrigin.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs12 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validateWorkflowCreateOrigin.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateWorkflowCreateOrigin.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validateWorkflowCreateOrigin.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validateWorkflowCreateOrigin.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowCreateOrigin.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowCreateOrigin.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link WorkflowDefinitionCreateRequest}. */
// prettier-ignore
export const validateWorkflowDefinitionCreateRequest: CompiledSchemaCheck<WorkflowDefinitionCreateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionCreateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionCreateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.document === undefined) && (missing0 = "document")) || ((data.origin === undefined) && (missing0 = "origin"))){validateWorkflowDefinitionCreateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "document") || (key0 === "origin"))){validateWorkflowDefinitionCreateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.document !== undefined){const _errs2: any = errors;if(!(validateWorkflowDocument.call(this, data.document, {instancePath:instancePath+"/document",parentData:data,parentDataProperty:"document",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDocument.errors : vErrors.concat(validateWorkflowDocument.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.origin !== undefined){const _errs3: any = errors;if(!(validateWorkflowCreateOrigin.call(this, data.origin, {instancePath:instancePath+"/origin",parentData:data,parentDataProperty:"origin",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowCreateOrigin.errors : vErrors.concat(validateWorkflowCreateOrigin.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowDefinitionCreateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionCreateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionCreateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionCreateResponse}. */
// prettier-ignore
export const validateWorkflowDefinitionCreateResponse: CompiledSchemaCheck<WorkflowDefinitionCreateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionCreateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionCreateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.versionNumber === undefined) && (missing0 = "versionNumber"))) || ((data.contentHash === undefined) && (missing0 = "contentHash"))) || ((data.workflowVersionId === undefined) && (missing0 = "workflowVersionId"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))){validateWorkflowDefinitionCreateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "definitionId") || (key0 === "versionNumber")) || (key0 === "contentHash")) || (key0 === "workflowVersionId")) || (key0 === "createdAt"))){validateWorkflowDefinitionCreateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.versionNumber !== undefined){let data1: any = data.versionNumber;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowDefinitionCreateResponse.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowDefinitionCreateResponse.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateWorkflowDefinitionCreateResponse.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.contentHash !== undefined){const _errs5: any = errors;if(!(validateWorkflowContentHash.call(this, data.contentHash, {instancePath:instancePath+"/contentHash",parentData:data,parentDataProperty:"contentHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowContentHash.errors : vErrors.concat(validateWorkflowContentHash.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.workflowVersionId !== undefined){const _errs6: any = errors;if(!(validateWorkflowVersionId.call(this, data.workflowVersionId, {instancePath:instancePath+"/workflowVersionId",parentData:data,parentDataProperty:"workflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.createdAt !== undefined){const _errs7: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}}else {validateWorkflowDefinitionCreateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionCreateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionCreateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionReadRequest}. */
// prettier-ignore
export const validateWorkflowDefinitionReadRequest: CompiledSchemaCheck<WorkflowDefinitionReadRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionReadRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.definitionId === undefined) && (missing0 = "definitionId")){validateWorkflowDefinitionReadRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitionId") || (key0 === "version"))){validateWorkflowDefinitionReadRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.version !== undefined){let data1: any = data.version;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowDefinitionReadRequest.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowDefinitionReadRequest.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateWorkflowDefinitionReadRequest.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowDefinitionReadRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionReadRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionReadRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1475: any = {"description":"What a webhook fire came to: a run started, skipped because a run was still going, waiting to\nrun once the going run finishes, or refused for a token that did not match.","type":"string","enum":["started","skipped","waiting","tokenMismatch"]};
/** Checks that a value is a {@link WorkflowWebhookFireOutcome}. */
// prettier-ignore
export const validateWorkflowWebhookFireOutcome: CompiledSchemaCheck<WorkflowWebhookFireOutcome> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowWebhookFireOutcome {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowWebhookFireOutcome.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowWebhookFireOutcome.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "started") || (data === "skipped")) || (data === "waiting")) || (data === "tokenMismatch"))){validateWorkflowWebhookFireOutcome.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1475.enum}}];return false;}validateWorkflowWebhookFireOutcome.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowWebhookFireOutcome.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowWebhookLastFire}. */
// prettier-ignore
export const validateWorkflowWebhookLastFire: CompiledSchemaCheck<WorkflowWebhookLastFire> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowWebhookLastFire {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowWebhookLastFire.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.at === undefined) && (missing0 = "at")) || ((data.outcome === undefined) && (missing0 = "outcome"))){validateWorkflowWebhookLastFire.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "at") || (key0 === "outcome"))){validateWorkflowWebhookLastFire.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.at !== undefined){const _errs2: any = errors;if(!(validateWireInstant.call(this, data.at, {instancePath:instancePath+"/at",parentData:data,parentDataProperty:"at",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.outcome !== undefined){const _errs3: any = errors;if(!(validateWorkflowWebhookFireOutcome.call(this, data.outcome, {instancePath:instancePath+"/outcome",parentData:data,parentDataProperty:"outcome",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowWebhookFireOutcome.errors : vErrors.concat(validateWorkflowWebhookFireOutcome.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowWebhookLastFire.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowWebhookLastFire.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowWebhookLastFire.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1473: any = {"type":"object","additionalProperties":false,"properties":{"id":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId","description":"The workflow."},"name":{"type":"string","minLength":1,"description":"Its name."},"versionNumber":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The version read's number."},"workflowVersionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId","description":"The version read's id, the one a run start takes."},"contentHash":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowContentHash","description":"The hash of that version's hashed body."},"document":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDocument","description":"That version's document."},"permissionLevel":{"$ref":"sidekicks-contracts:session/controls/methods#/$defs/PermissionLevel","description":"The workflow's own level, which every run of it uses and the builder's level pill\nreads."},"backgroundBrowser":{"$ref":"sidekicks-contracts:workflow/definition/builder#/$defs/WorkflowBackgroundBrowser","description":"The browser the workflow's runs use in the background, which the builder's browser\npill reads; a new workflow reads `settingsDefault`."},"provider":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider whose sandbox and shell the workflow's command steps run in; absent\nuntil one is chosen."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the workflow was made."},"webhookLastFire":{"$ref":"#/$defs/WorkflowWebhookLastFire","description":"The last call to the workflow's webhook address and what became of it."},"deletedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the workflow was deleted, absent while it is not. A deleted workflow still\nreads, so a run filter can name it; the builder opens no deleted workflow."},"webhookTokenCreatedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the webhook token was made."},"webhookTokenLastUsedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When a call last presented the token; absent until one has."}},"required":["id","name","versionNumber","workflowVersionId","contentHash","document","permissionLevel","backgroundBrowser","createdAt","webhookTokenCreatedAt"],"description":"A definition read of a workflow that holds a webhook token: when it was made, and when a\ncall last presented it."};
/** Checks that a value is a {@link WorkflowDefinitionReadWithWebhookToken}. */
// prettier-ignore
export const validateWorkflowDefinitionReadWithWebhookToken: CompiledSchemaCheck<WorkflowDefinitionReadWithWebhookToken> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionReadWithWebhookToken {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionReadWithWebhookToken.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((((data.id === undefined) && (missing0 = "id")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.versionNumber === undefined) && (missing0 = "versionNumber"))) || ((data.workflowVersionId === undefined) && (missing0 = "workflowVersionId"))) || ((data.contentHash === undefined) && (missing0 = "contentHash"))) || ((data.document === undefined) && (missing0 = "document"))) || ((data.permissionLevel === undefined) && (missing0 = "permissionLevel"))) || ((data.backgroundBrowser === undefined) && (missing0 = "backgroundBrowser"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))) || ((data.webhookTokenCreatedAt === undefined) && (missing0 = "webhookTokenCreatedAt"))){validateWorkflowDefinitionReadWithWebhookToken.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1473.properties, key0))){validateWorkflowDefinitionReadWithWebhookToken.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validateWorkflowDefinitionReadWithWebhookToken.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowDefinitionReadWithWebhookToken.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.versionNumber !== undefined){let data2: any = data.versionNumber;const _errs5: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateWorkflowDefinitionReadWithWebhookToken.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateWorkflowDefinitionReadWithWebhookToken.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateWorkflowDefinitionReadWithWebhookToken.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.workflowVersionId !== undefined){const _errs7: any = errors;if(!(validateWorkflowVersionId.call(this, data.workflowVersionId, {instancePath:instancePath+"/workflowVersionId",parentData:data,parentDataProperty:"workflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.contentHash !== undefined){const _errs8: any = errors;if(!(validateWorkflowContentHash.call(this, data.contentHash, {instancePath:instancePath+"/contentHash",parentData:data,parentDataProperty:"contentHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowContentHash.errors : vErrors.concat(validateWorkflowContentHash.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.document !== undefined){const _errs9: any = errors;if(!(validateWorkflowDocument.call(this, data.document, {instancePath:instancePath+"/document",parentData:data,parentDataProperty:"document",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDocument.errors : vErrors.concat(validateWorkflowDocument.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.permissionLevel !== undefined){const _errs10: any = errors;if(!(validatePermissionLevel.call(this, data.permissionLevel, {instancePath:instancePath+"/permissionLevel",parentData:data,parentDataProperty:"permissionLevel",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePermissionLevel.errors : vErrors.concat(validatePermissionLevel.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.backgroundBrowser !== undefined){const _errs11: any = errors;if(!(validateWorkflowBackgroundBrowser.call(this, data.backgroundBrowser, {instancePath:instancePath+"/backgroundBrowser",parentData:data,parentDataProperty:"backgroundBrowser",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowBackgroundBrowser.errors : vErrors.concat(validateWorkflowBackgroundBrowser.errors);errors = vErrors.length;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){const _errs12: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.createdAt !== undefined){const _errs13: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.webhookLastFire !== undefined){const _errs14: any = errors;if(!(validateWorkflowWebhookLastFire.call(this, data.webhookLastFire, {instancePath:instancePath+"/webhookLastFire",parentData:data,parentDataProperty:"webhookLastFire",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowWebhookLastFire.errors : vErrors.concat(validateWorkflowWebhookLastFire.errors);errors = vErrors.length;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.deletedAt !== undefined){const _errs15: any = errors;if(!(validateWireInstant.call(this, data.deletedAt, {instancePath:instancePath+"/deletedAt",parentData:data,parentDataProperty:"deletedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.webhookTokenCreatedAt !== undefined){const _errs16: any = errors;if(!(validateWireInstant.call(this, data.webhookTokenCreatedAt, {instancePath:instancePath+"/webhookTokenCreatedAt",parentData:data,parentDataProperty:"webhookTokenCreatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.webhookTokenLastUsedAt !== undefined){const _errs17: any = errors;if(!(validateWireInstant.call(this, data.webhookTokenLastUsedAt, {instancePath:instancePath+"/webhookTokenLastUsedAt",parentData:data,parentDataProperty:"webhookTokenLastUsedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}}}else {validateWorkflowDefinitionReadWithWebhookToken.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionReadWithWebhookToken.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionReadWithWebhookToken.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1476: any = {"type":"object","additionalProperties":false,"properties":{"id":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId","description":"The workflow."},"name":{"type":"string","minLength":1,"description":"Its name."},"versionNumber":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The version read's number."},"workflowVersionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId","description":"The version read's id, the one a run start takes."},"contentHash":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowContentHash","description":"The hash of that version's hashed body."},"document":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDocument","description":"That version's document."},"permissionLevel":{"$ref":"sidekicks-contracts:session/controls/methods#/$defs/PermissionLevel","description":"The workflow's own level, which every run of it uses and the builder's level pill\nreads."},"backgroundBrowser":{"$ref":"sidekicks-contracts:workflow/definition/builder#/$defs/WorkflowBackgroundBrowser","description":"The browser the workflow's runs use in the background, which the builder's browser\npill reads; a new workflow reads `settingsDefault`."},"provider":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider whose sandbox and shell the workflow's command steps run in; absent\nuntil one is chosen."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the workflow was made."},"webhookLastFire":{"$ref":"#/$defs/WorkflowWebhookLastFire","description":"The last call to the workflow's webhook address and what became of it."},"deletedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the workflow was deleted, absent while it is not. A deleted workflow still\nreads, so a run filter can name it; the builder opens no deleted workflow."},"webhookTokenCreatedAt":{"not":{},"tsType":"never","description":"Never present: there is no token."},"webhookTokenLastUsedAt":{"not":{},"tsType":"never","description":"Never present: there is no token."}},"required":["id","name","versionNumber","workflowVersionId","contentHash","document","permissionLevel","backgroundBrowser","createdAt"],"description":"A definition read of a workflow that holds no webhook token, so no call to its address is\ntaken."};
/** Checks that a value is a {@link WorkflowDefinitionReadWithoutWebhookToken}. */
// prettier-ignore
export const validateWorkflowDefinitionReadWithoutWebhookToken: CompiledSchemaCheck<WorkflowDefinitionReadWithoutWebhookToken> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionReadWithoutWebhookToken {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionReadWithoutWebhookToken.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((data.id === undefined) && (missing0 = "id")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.versionNumber === undefined) && (missing0 = "versionNumber"))) || ((data.workflowVersionId === undefined) && (missing0 = "workflowVersionId"))) || ((data.contentHash === undefined) && (missing0 = "contentHash"))) || ((data.document === undefined) && (missing0 = "document"))) || ((data.permissionLevel === undefined) && (missing0 = "permissionLevel"))) || ((data.backgroundBrowser === undefined) && (missing0 = "backgroundBrowser"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))){validateWorkflowDefinitionReadWithoutWebhookToken.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1476.properties, key0))){validateWorkflowDefinitionReadWithoutWebhookToken.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validateWorkflowDefinitionReadWithoutWebhookToken.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowDefinitionReadWithoutWebhookToken.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.versionNumber !== undefined){let data2: any = data.versionNumber;const _errs5: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateWorkflowDefinitionReadWithoutWebhookToken.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateWorkflowDefinitionReadWithoutWebhookToken.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateWorkflowDefinitionReadWithoutWebhookToken.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.workflowVersionId !== undefined){const _errs7: any = errors;if(!(validateWorkflowVersionId.call(this, data.workflowVersionId, {instancePath:instancePath+"/workflowVersionId",parentData:data,parentDataProperty:"workflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.contentHash !== undefined){const _errs8: any = errors;if(!(validateWorkflowContentHash.call(this, data.contentHash, {instancePath:instancePath+"/contentHash",parentData:data,parentDataProperty:"contentHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowContentHash.errors : vErrors.concat(validateWorkflowContentHash.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.document !== undefined){const _errs9: any = errors;if(!(validateWorkflowDocument.call(this, data.document, {instancePath:instancePath+"/document",parentData:data,parentDataProperty:"document",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDocument.errors : vErrors.concat(validateWorkflowDocument.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.permissionLevel !== undefined){const _errs10: any = errors;if(!(validatePermissionLevel.call(this, data.permissionLevel, {instancePath:instancePath+"/permissionLevel",parentData:data,parentDataProperty:"permissionLevel",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePermissionLevel.errors : vErrors.concat(validatePermissionLevel.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.backgroundBrowser !== undefined){const _errs11: any = errors;if(!(validateWorkflowBackgroundBrowser.call(this, data.backgroundBrowser, {instancePath:instancePath+"/backgroundBrowser",parentData:data,parentDataProperty:"backgroundBrowser",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowBackgroundBrowser.errors : vErrors.concat(validateWorkflowBackgroundBrowser.errors);errors = vErrors.length;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){const _errs12: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.createdAt !== undefined){const _errs13: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.webhookLastFire !== undefined){const _errs14: any = errors;if(!(validateWorkflowWebhookLastFire.call(this, data.webhookLastFire, {instancePath:instancePath+"/webhookLastFire",parentData:data,parentDataProperty:"webhookLastFire",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowWebhookLastFire.errors : vErrors.concat(validateWorkflowWebhookLastFire.errors);errors = vErrors.length;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.deletedAt !== undefined){const _errs15: any = errors;if(!(validateWireInstant.call(this, data.deletedAt, {instancePath:instancePath+"/deletedAt",parentData:data,parentDataProperty:"deletedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.webhookTokenCreatedAt !== undefined){const _errs16: any = errors;validateWorkflowDefinitionReadWithoutWebhookToken.errors = [{instancePath:instancePath+"/webhookTokenCreatedAt",schemaPath:"#/properties/webhookTokenCreatedAt/not",keyword:"not",params:{}}];return false;var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.webhookTokenLastUsedAt !== undefined){const _errs19: any = errors;validateWorkflowDefinitionReadWithoutWebhookToken.errors = [{instancePath:instancePath+"/webhookTokenLastUsedAt",schemaPath:"#/properties/webhookTokenLastUsedAt/not",keyword:"not",params:{}}];return false;var valid0: any = _errs19 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}}}else {validateWorkflowDefinitionReadWithoutWebhookToken.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionReadWithoutWebhookToken.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionReadWithoutWebhookToken.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionReadResponse}. */
// prettier-ignore
export const validateWorkflowDefinitionReadResponse: CompiledSchemaCheck<WorkflowDefinitionReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validateWorkflowDefinitionReadWithWebhookToken.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionReadWithWebhookToken.errors : vErrors.concat(validateWorkflowDefinitionReadWithWebhookToken.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs2: any = errors;if(!(validateWorkflowDefinitionReadWithoutWebhookToken.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionReadWithoutWebhookToken.errors : vErrors.concat(validateWorkflowDefinitionReadWithoutWebhookToken.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validateWorkflowDefinitionReadResponse.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateWorkflowDefinitionReadResponse.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionReadResponse.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionListCursor}. */
// prettier-ignore
export const validateWorkflowDefinitionListCursor: CompiledSchemaCheck<WorkflowDefinitionListCursor> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionListCursor {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionListCursor.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateWorkflowDefinitionListCursor.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateWorkflowDefinitionListCursor.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateWorkflowDefinitionListCursor.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowDefinitionListCursor.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionListCursor.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionListRequest}. */
// prettier-ignore
export const validateWorkflowDefinitionListRequest: CompiledSchemaCheck<WorkflowDefinitionListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!((key0 === "limit") || (key0 === "cursor"))){validateWorkflowDefinitionListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.limit !== undefined){let data0: any = data.limit;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateWorkflowDefinitionListRequest.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateWorkflowDefinitionListRequest.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validateWorkflowDefinitionListRequest.errors = [{instancePath:instancePath+"/limit",schemaPath:"#/properties/limit/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.cursor !== undefined){const _errs4: any = errors;if(!(validateWorkflowDefinitionListCursor.call(this, data.cursor, {instancePath:instancePath+"/cursor",parentData:data,parentDataProperty:"cursor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionListCursor.errors : vErrors.concat(validateWorkflowDefinitionListCursor.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}else {validateWorkflowDefinitionListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionLastRun}. */
// prettier-ignore
export const validateWorkflowDefinitionLastRun: CompiledSchemaCheck<WorkflowDefinitionLastRun> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionLastRun {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionLastRun.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.workflowRunId === undefined) && (missing0 = "workflowRunId")) || ((data.status === undefined) && (missing0 = "status"))) || ((data.startedAt === undefined) && (missing0 = "startedAt"))){validateWorkflowDefinitionLastRun.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "workflowRunId") || (key0 === "status")) || (key0 === "startedAt"))){validateWorkflowDefinitionLastRun.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.workflowRunId !== undefined){const _errs2: any = errors;if(!(validateWorkflowRunId.call(this, data.workflowRunId, {instancePath:instancePath+"/workflowRunId",parentData:data,parentDataProperty:"workflowRunId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){const _errs3: any = errors;if(!(validateWorkflowRunStatus.call(this, data.status, {instancePath:instancePath+"/status",parentData:data,parentDataProperty:"status",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunStatus.errors : vErrors.concat(validateWorkflowRunStatus.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.startedAt !== undefined){const _errs4: any = errors;if(!(validateWireInstant.call(this, data.startedAt, {instancePath:instancePath+"/startedAt",parentData:data,parentDataProperty:"startedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowDefinitionLastRun.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionLastRun.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionLastRun.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionSchedule}. */
// prettier-ignore
export const validateWorkflowDefinitionSchedule: CompiledSchemaCheck<WorkflowDefinitionSchedule> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionSchedule {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionSchedule.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.expression === undefined) && (missing0 = "expression")) || ((data.timeZone === undefined) && (missing0 = "timeZone"))){validateWorkflowDefinitionSchedule.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "expression") || (key0 === "timeZone")) || (key0 === "nextFireAt"))){validateWorkflowDefinitionSchedule.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.expression !== undefined){let data0: any = data.expression;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateWorkflowDefinitionSchedule.errors = [{instancePath:instancePath+"/expression",schemaPath:"#/properties/expression/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowDefinitionSchedule.errors = [{instancePath:instancePath+"/expression",schemaPath:"#/properties/expression/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.timeZone !== undefined){let data1: any = data.timeZone;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validateWorkflowDefinitionSchedule.errors = [{instancePath:instancePath+"/timeZone",schemaPath:"#/properties/timeZone/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowDefinitionSchedule.errors = [{instancePath:instancePath+"/timeZone",schemaPath:"#/properties/timeZone/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.nextFireAt !== undefined){const _errs6: any = errors;if(!(validateWireInstant.call(this, data.nextFireAt, {instancePath:instancePath+"/nextFireAt",parentData:data,parentDataProperty:"nextFireAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowDefinitionSchedule.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionSchedule.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionSchedule.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowSkippedFire}. */
// prettier-ignore
export const validateWorkflowSkippedFire: CompiledSchemaCheck<WorkflowSkippedFire> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowSkippedFire {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowSkippedFire.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.scheduledAt === undefined) && (missing0 = "scheduledAt")) || ((data.runningSince === undefined) && (missing0 = "runningSince"))){validateWorkflowSkippedFire.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "scheduledAt") || (key0 === "runningSince"))){validateWorkflowSkippedFire.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.scheduledAt !== undefined){const _errs2: any = errors;if(!(validateWireInstant.call(this, data.scheduledAt, {instancePath:instancePath+"/scheduledAt",parentData:data,parentDataProperty:"scheduledAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runningSince !== undefined){const _errs3: any = errors;if(!(validateWireInstant.call(this, data.runningSince, {instancePath:instancePath+"/runningSince",parentData:data,parentDataProperty:"runningSince",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowSkippedFire.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowSkippedFire.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowSkippedFire.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1466: any = {"type":"object","additionalProperties":false,"properties":{"id":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId","description":"The workflow."},"name":{"type":"string","minLength":1,"description":"Its name."},"latestVersionNumber":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The latest version's number, which a version read addresses; passed through beside\n`latestWorkflowVersionId`, never derived from it."},"latestWorkflowVersionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId","description":"The latest version's id, which a run start takes."},"contentHash":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowContentHash","description":"The hash of the latest version's hashed body."},"triggerKind":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeKindId","description":"The kind of the document's one trigger."},"lastRun":{"$ref":"#/$defs/WorkflowDefinitionLastRun","description":"The last run; absent where the workflow never ran, which is no failure."},"schedule":{"$ref":"#/$defs/WorkflowDefinitionSchedule","description":"The schedule; absent where the workflow declares none."},"lastSkippedFire":{"$ref":"#/$defs/WorkflowSkippedFire","description":"The last fire the trigger's overlap choice skipped."},"enabled":{"type":"boolean","description":"Whether the workflow's triggers are armed: the toggle's own truth, so the row reverts\nvisibly when the daemon refuses rather than holding an optimistic value."},"tags":{"$ref":"sidekicks-contracts:tag#/$defs/TagList","description":"The workflow's tags."},"runCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How many runs it has."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was made."},"updatedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it last changed."}},"required":["id","name","latestVersionNumber","latestWorkflowVersionId","contentHash","triggerKind","enabled","tags","runCount","createdAt","updatedAt"],"description":"One definition in a list, with what a catalog row shows beside the name, so the table needs no\nsecond read per row."};
/** Checks that a value is a {@link WorkflowDefinitionSummary}. */
// prettier-ignore
export const validateWorkflowDefinitionSummary: CompiledSchemaCheck<WorkflowDefinitionSummary> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionSummary {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionSummary.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((((data.id === undefined) && (missing0 = "id")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.latestVersionNumber === undefined) && (missing0 = "latestVersionNumber"))) || ((data.latestWorkflowVersionId === undefined) && (missing0 = "latestWorkflowVersionId"))) || ((data.contentHash === undefined) && (missing0 = "contentHash"))) || ((data.triggerKind === undefined) && (missing0 = "triggerKind"))) || ((data.enabled === undefined) && (missing0 = "enabled"))) || ((data.tags === undefined) && (missing0 = "tags"))) || ((data.runCount === undefined) && (missing0 = "runCount"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))) || ((data.updatedAt === undefined) && (missing0 = "updatedAt"))){validateWorkflowDefinitionSummary.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1466.properties, key0))){validateWorkflowDefinitionSummary.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validateWorkflowDefinitionSummary.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowDefinitionSummary.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.latestVersionNumber !== undefined){let data2: any = data.latestVersionNumber;const _errs5: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateWorkflowDefinitionSummary.errors = [{instancePath:instancePath+"/latestVersionNumber",schemaPath:"#/properties/latestVersionNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateWorkflowDefinitionSummary.errors = [{instancePath:instancePath+"/latestVersionNumber",schemaPath:"#/properties/latestVersionNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateWorkflowDefinitionSummary.errors = [{instancePath:instancePath+"/latestVersionNumber",schemaPath:"#/properties/latestVersionNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.latestWorkflowVersionId !== undefined){const _errs7: any = errors;if(!(validateWorkflowVersionId.call(this, data.latestWorkflowVersionId, {instancePath:instancePath+"/latestWorkflowVersionId",parentData:data,parentDataProperty:"latestWorkflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.contentHash !== undefined){const _errs8: any = errors;if(!(validateWorkflowContentHash.call(this, data.contentHash, {instancePath:instancePath+"/contentHash",parentData:data,parentDataProperty:"contentHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowContentHash.errors : vErrors.concat(validateWorkflowContentHash.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.triggerKind !== undefined){const _errs9: any = errors;if(!(validateWorkflowNodeKindId.call(this, data.triggerKind, {instancePath:instancePath+"/triggerKind",parentData:data,parentDataProperty:"triggerKind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeKindId.errors : vErrors.concat(validateWorkflowNodeKindId.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastRun !== undefined){const _errs10: any = errors;if(!(validateWorkflowDefinitionLastRun.call(this, data.lastRun, {instancePath:instancePath+"/lastRun",parentData:data,parentDataProperty:"lastRun",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionLastRun.errors : vErrors.concat(validateWorkflowDefinitionLastRun.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.schedule !== undefined){const _errs11: any = errors;if(!(validateWorkflowDefinitionSchedule.call(this, data.schedule, {instancePath:instancePath+"/schedule",parentData:data,parentDataProperty:"schedule",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionSchedule.errors : vErrors.concat(validateWorkflowDefinitionSchedule.errors);errors = vErrors.length;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastSkippedFire !== undefined){const _errs12: any = errors;if(!(validateWorkflowSkippedFire.call(this, data.lastSkippedFire, {instancePath:instancePath+"/lastSkippedFire",parentData:data,parentDataProperty:"lastSkippedFire",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowSkippedFire.errors : vErrors.concat(validateWorkflowSkippedFire.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.enabled !== undefined){const _errs13: any = errors;if(typeof data.enabled !== "boolean"){validateWorkflowDefinitionSummary.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.tags !== undefined){const _errs15: any = errors;if(!(validateTagList.call(this, data.tags, {instancePath:instancePath+"/tags",parentData:data,parentDataProperty:"tags",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTagList.errors : vErrors.concat(validateTagList.errors);errors = vErrors.length;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.runCount !== undefined){let data11: any = data.runCount;const _errs16: any = errors;if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){validateWorkflowDefinitionSummary.errors = [{instancePath:instancePath+"/runCount",schemaPath:"#/properties/runCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs16){if((typeof data11 == "number") && (isFinite(data11))){if(data11 > 9007199254740991 || isNaN(data11)){validateWorkflowDefinitionSummary.errors = [{instancePath:instancePath+"/runCount",schemaPath:"#/properties/runCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data11 < 0 || isNaN(data11)){validateWorkflowDefinitionSummary.errors = [{instancePath:instancePath+"/runCount",schemaPath:"#/properties/runCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.createdAt !== undefined){const _errs18: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.updatedAt !== undefined){const _errs19: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}}}else {validateWorkflowDefinitionSummary.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionSummary.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionSummary.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionListResponse}. */
// prettier-ignore
export const validateWorkflowDefinitionListResponse: CompiledSchemaCheck<WorkflowDefinitionListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.definitions === undefined) && (missing0 = "definitions")){validateWorkflowDefinitionListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitions") || (key0 === "nextCursor"))){validateWorkflowDefinitionListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitions !== undefined){let data0: any = data.definitions;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateWorkflowDefinitionSummary.call(this, data0[i0], {instancePath:instancePath+"/definitions/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionSummary.errors : vErrors.concat(validateWorkflowDefinitionSummary.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateWorkflowDefinitionListResponse.errors = [{instancePath:instancePath+"/definitions",schemaPath:"#/properties/definitions/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nextCursor !== undefined){const _errs5: any = errors;if(!(validateWorkflowDefinitionListCursor.call(this, data.nextCursor, {instancePath:instancePath+"/nextCursor",parentData:data,parentDataProperty:"nextCursor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionListCursor.errors : vErrors.concat(validateWorkflowDefinitionListCursor.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowDefinitionListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionUpdateRequest}. */
// prettier-ignore
export const validateWorkflowDefinitionUpdateRequest: CompiledSchemaCheck<WorkflowDefinitionUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.expectedVersionNumber === undefined) && (missing0 = "expectedVersionNumber"))) || ((data.document === undefined) && (missing0 = "document"))){validateWorkflowDefinitionUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "definitionId") || (key0 === "expectedVersionNumber")) || (key0 === "document")) || (key0 === "restoredVersionNumber"))){validateWorkflowDefinitionUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.expectedVersionNumber !== undefined){let data1: any = data.expectedVersionNumber;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowDefinitionUpdateRequest.errors = [{instancePath:instancePath+"/expectedVersionNumber",schemaPath:"#/properties/expectedVersionNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowDefinitionUpdateRequest.errors = [{instancePath:instancePath+"/expectedVersionNumber",schemaPath:"#/properties/expectedVersionNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateWorkflowDefinitionUpdateRequest.errors = [{instancePath:instancePath+"/expectedVersionNumber",schemaPath:"#/properties/expectedVersionNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.document !== undefined){const _errs5: any = errors;if(!(validateWorkflowDocument.call(this, data.document, {instancePath:instancePath+"/document",parentData:data,parentDataProperty:"document",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDocument.errors : vErrors.concat(validateWorkflowDocument.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.restoredVersionNumber !== undefined){let data3: any = data.restoredVersionNumber;const _errs6: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateWorkflowDefinitionUpdateRequest.errors = [{instancePath:instancePath+"/restoredVersionNumber",schemaPath:"#/properties/restoredVersionNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateWorkflowDefinitionUpdateRequest.errors = [{instancePath:instancePath+"/restoredVersionNumber",schemaPath:"#/properties/restoredVersionNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validateWorkflowDefinitionUpdateRequest.errors = [{instancePath:instancePath+"/restoredVersionNumber",schemaPath:"#/properties/restoredVersionNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateWorkflowDefinitionUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionUpdateResponse}. */
// prettier-ignore
export const validateWorkflowDefinitionUpdateResponse: CompiledSchemaCheck<WorkflowDefinitionUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.versionNumber === undefined) && (missing0 = "versionNumber"))) || ((data.workflowVersionId === undefined) && (missing0 = "workflowVersionId"))) || ((data.contentHash === undefined) && (missing0 = "contentHash"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))){validateWorkflowDefinitionUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "definitionId") || (key0 === "versionNumber")) || (key0 === "workflowVersionId")) || (key0 === "contentHash")) || (key0 === "createdAt"))){validateWorkflowDefinitionUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.versionNumber !== undefined){let data1: any = data.versionNumber;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowDefinitionUpdateResponse.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowDefinitionUpdateResponse.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateWorkflowDefinitionUpdateResponse.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.workflowVersionId !== undefined){const _errs5: any = errors;if(!(validateWorkflowVersionId.call(this, data.workflowVersionId, {instancePath:instancePath+"/workflowVersionId",parentData:data,parentDataProperty:"workflowVersionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowVersionId.errors : vErrors.concat(validateWorkflowVersionId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.contentHash !== undefined){const _errs6: any = errors;if(!(validateWorkflowContentHash.call(this, data.contentHash, {instancePath:instancePath+"/contentHash",parentData:data,parentDataProperty:"contentHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowContentHash.errors : vErrors.concat(validateWorkflowContentHash.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.createdAt !== undefined){const _errs7: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}}else {validateWorkflowDefinitionUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionDeleteRequest}. */
// prettier-ignore
export const validateWorkflowDefinitionDeleteRequest: CompiledSchemaCheck<WorkflowDefinitionDeleteRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionDeleteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionDeleteRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.definitionId === undefined) && (missing0 = "definitionId")){validateWorkflowDefinitionDeleteRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "definitionId")){validateWorkflowDefinitionDeleteRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}}}}}else {validateWorkflowDefinitionDeleteRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionDeleteRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionDeleteRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionDeleteResponse}. */
// prettier-ignore
export const validateWorkflowDefinitionDeleteResponse: CompiledSchemaCheck<WorkflowDefinitionDeleteResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionDeleteResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionDeleteResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.deleted === undefined) && (missing0 = "deleted"))) || ((data.retainedRunCount === undefined) && (missing0 = "retainedRunCount"))){validateWorkflowDefinitionDeleteResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "definitionId") || (key0 === "deleted")) || (key0 === "retainedRunCount"))){validateWorkflowDefinitionDeleteResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.deleted !== undefined){let data1: any = data.deleted;const _errs3: any = errors;if(typeof data1 !== "boolean"){validateWorkflowDefinitionDeleteResponse.errors = [{instancePath:instancePath+"/deleted",schemaPath:"#/properties/deleted/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data1){validateWorkflowDefinitionDeleteResponse.errors = [{instancePath:instancePath+"/deleted",schemaPath:"#/properties/deleted/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.retainedRunCount !== undefined){let data2: any = data.retainedRunCount;const _errs5: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateWorkflowDefinitionDeleteResponse.errors = [{instancePath:instancePath+"/retainedRunCount",schemaPath:"#/properties/retainedRunCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateWorkflowDefinitionDeleteResponse.errors = [{instancePath:instancePath+"/retainedRunCount",schemaPath:"#/properties/retainedRunCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateWorkflowDefinitionDeleteResponse.errors = [{instancePath:instancePath+"/retainedRunCount",schemaPath:"#/properties/retainedRunCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowDefinitionDeleteResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionDeleteResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionDeleteResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link WorkflowDefinitionExportRequest}. */
// prettier-ignore
export const validateWorkflowDefinitionExportRequest: CompiledSchemaCheck<WorkflowDefinitionExportRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionExportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionExportRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.filePath === undefined) && (missing0 = "filePath"))){validateWorkflowDefinitionExportRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "definitionId") || (key0 === "version")) || (key0 === "includeLayout")) || (key0 === "filePath"))){validateWorkflowDefinitionExportRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.version !== undefined){let data1: any = data.version;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowDefinitionExportRequest.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowDefinitionExportRequest.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateWorkflowDefinitionExportRequest.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.includeLayout !== undefined){const _errs5: any = errors;if(typeof data.includeLayout !== "boolean"){validateWorkflowDefinitionExportRequest.errors = [{instancePath:instancePath+"/includeLayout",schemaPath:"#/properties/includeLayout/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.filePath !== undefined){let data3: any = data.filePath;const _errs7: any = errors;if(errors === _errs7){if(typeof data3 === "string"){if(func1(data3) > 4096){validateWorkflowDefinitionExportRequest.errors = [{instancePath:instancePath+"/filePath",schemaPath:"#/properties/filePath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validateWorkflowDefinitionExportRequest.errors = [{instancePath:instancePath+"/filePath",schemaPath:"#/properties/filePath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data3)){validateWorkflowDefinitionExportRequest.errors = [{instancePath:instancePath+"/filePath",schemaPath:"#/properties/filePath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateWorkflowDefinitionExportRequest.errors = [{instancePath:instancePath+"/filePath",schemaPath:"#/properties/filePath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}else {validateWorkflowDefinitionExportRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionExportRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionExportRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionExportResponse}. */
// prettier-ignore
export const validateWorkflowDefinitionExportResponse: CompiledSchemaCheck<WorkflowDefinitionExportResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionExportResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionExportResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.versionNumber === undefined) && (missing0 = "versionNumber"))) || ((data.contentHash === undefined) && (missing0 = "contentHash"))){validateWorkflowDefinitionExportResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "definitionId") || (key0 === "versionNumber")) || (key0 === "contentHash"))){validateWorkflowDefinitionExportResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.versionNumber !== undefined){let data1: any = data.versionNumber;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowDefinitionExportResponse.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowDefinitionExportResponse.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateWorkflowDefinitionExportResponse.errors = [{instancePath:instancePath+"/versionNumber",schemaPath:"#/properties/versionNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.contentHash !== undefined){const _errs5: any = errors;if(!(validateWorkflowContentHash.call(this, data.contentHash, {instancePath:instancePath+"/contentHash",parentData:data,parentDataProperty:"contentHash",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowContentHash.errors : vErrors.concat(validateWorkflowContentHash.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowDefinitionExportResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionExportResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionExportResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionImportRequest}. */
// prettier-ignore
export const validateWorkflowDefinitionImportRequest: CompiledSchemaCheck<WorkflowDefinitionImportRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionImportRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionImportRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.filePath === undefined) && (missing0 = "filePath")){validateWorkflowDefinitionImportRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "filePath")){validateWorkflowDefinitionImportRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.filePath !== undefined){let data0: any = data.filePath;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 4096){validateWorkflowDefinitionImportRequest.errors = [{instancePath:instancePath+"/filePath",schemaPath:"#/properties/filePath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data0) < 1){validateWorkflowDefinitionImportRequest.errors = [{instancePath:instancePath+"/filePath",schemaPath:"#/properties/filePath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data0)){validateWorkflowDefinitionImportRequest.errors = [{instancePath:instancePath+"/filePath",schemaPath:"#/properties/filePath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateWorkflowDefinitionImportRequest.errors = [{instancePath:instancePath+"/filePath",schemaPath:"#/properties/filePath/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateWorkflowDefinitionImportRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionImportRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionImportRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link WORKFLOW_DEFINITION_METHOD_DESCRIPTORS}, each with its checks. */
export interface WorkflowDefinitionMethodDescriptors {
  readonly "workflow.definition.create": {
    readonly method: "workflow.definition.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowDefinitionCreateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowDefinitionCreateResponse>;
  };
  readonly "workflow.definition.read": {
    readonly method: "workflow.definition.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowDefinitionReadRequest>;
    readonly responseCheck: SchemaCheck<WorkflowDefinitionReadResponse>;
  };
  readonly "workflow.definition.list": {
    readonly method: "workflow.definition.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowDefinitionListRequest>;
    readonly responseCheck: SchemaCheck<WorkflowDefinitionListResponse>;
  };
  readonly "workflow.version.read": {
    readonly method: "workflow.version.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowVersionReadRequest>;
    readonly responseCheck: SchemaCheck<WorkflowVersionReadResponse>;
  };
  readonly "workflow.version.list": {
    readonly method: "workflow.version.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowVersionListRequest>;
    readonly responseCheck: SchemaCheck<WorkflowVersionListResponse>;
  };
  readonly "workflow.definition.update": {
    readonly method: "workflow.definition.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowDefinitionUpdateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowDefinitionUpdateResponse>;
  };
  readonly "workflow.definition.delete": {
    readonly method: "workflow.definition.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowDefinitionDeleteRequest>;
    readonly responseCheck: SchemaCheck<WorkflowDefinitionDeleteResponse>;
  };
  readonly "workflow.definition.export": {
    readonly method: "workflow.definition.export";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowDefinitionExportRequest>;
    readonly responseCheck: SchemaCheck<WorkflowDefinitionExportResponse>;
  };
  readonly "workflow.definition.import": {
    readonly method: "workflow.definition.import";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowDefinitionImportRequest>;
    readonly responseCheck: SchemaCheck<WorkflowDefinitionCreateResponse>;
  };
  readonly "workflow.enabled.update": {
    readonly method: "workflow.enabled.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowEnabledUpdateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowEnabledUpdateResponse>;
  };
  readonly "workflow.layout.update": {
    readonly method: "workflow.layout.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowLayoutUpdateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowDefinitionSettingResponse>;
  };
  readonly "workflow.tags.update": {
    readonly method: "workflow.tags.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowTagsUpdateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowDefinitionSettingResponse>;
  };
  readonly "workflow.permissionLevel.update": {
    readonly method: "workflow.permissionLevel.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowPermissionLevelUpdateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowPermissionLevelUpdateResponse>;
  };
  readonly "workflow.backgroundBrowser.update": {
    readonly method: "workflow.backgroundBrowser.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowBackgroundBrowserUpdateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowBackgroundBrowserUpdateResponse>;
  };
  readonly "workflow.provider.update": {
    readonly method: "workflow.provider.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowProviderUpdateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowProviderUpdateResponse>;
  };
  readonly "workflow.pinData.update": {
    readonly method: "workflow.pinData.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowPinDataUpdateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowPinDataUpdateResponse>;
  };
  readonly "workflow.draft.update": {
    readonly method: "workflow.draft.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowDraftUpdateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowDraftUpdateResponse>;
  };
  readonly "workflow.draft.read": {
    readonly method: "workflow.draft.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowDraftReadRequest>;
    readonly responseCheck: SchemaCheck<WorkflowDraftReadResponse>;
  };
  readonly "workflow.expression.preview": {
    readonly method: "workflow.expression.preview";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowExpressionPreviewRequest>;
    readonly responseCheck: SchemaCheck<WorkflowExpressionPreviewResponse>;
  };
  readonly "workflow.version.diff.read": {
    readonly method: "workflow.version.diff.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowVersionDiffReadRequest>;
    readonly responseCheck: SchemaCheck<WorkflowVersionDiffReadResponse>;
  };
  readonly "workflow.webhookToken.rotate": {
    readonly method: "workflow.webhookToken.rotate";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowWebhookTokenRotateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowWebhookTokenRotateResponse>;
  };
  readonly "workflow.webhookListener.read": {
    readonly method: "workflow.webhookListener.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<WorkflowWebhookListenerReadResponse>;
  };
}
/**
 * The `workflow.*` methods over definitions: create, read, list, update, delete, export and
 * import, the version reads, and the settings, draft, expression preview and webhook kept
 * beside a workflow's versions.
 */
export const WORKFLOW_DEFINITION_METHOD_DESCRIPTORS: WorkflowDefinitionMethodDescriptors =
  Object.freeze({
    "workflow.definition.create": Object.freeze({
      method: "workflow.definition.create",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowDefinitionCreateRequest,
      responseCheck: validateWorkflowDefinitionCreateResponse,
    }),
    "workflow.definition.read": Object.freeze({
      method: "workflow.definition.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateWorkflowDefinitionReadRequest,
      responseCheck: validateWorkflowDefinitionReadResponse,
    }),
    "workflow.definition.list": Object.freeze({
      method: "workflow.definition.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateWorkflowDefinitionListRequest,
      responseCheck: validateWorkflowDefinitionListResponse,
    }),
    "workflow.version.read": Object.freeze({
      method: "workflow.version.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateWorkflowVersionReadRequest,
      responseCheck: validateWorkflowVersionReadResponse,
    }),
    "workflow.version.list": Object.freeze({
      method: "workflow.version.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateWorkflowVersionListRequest,
      responseCheck: validateWorkflowVersionListResponse,
    }),
    "workflow.definition.update": Object.freeze({
      method: "workflow.definition.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowDefinitionUpdateRequest,
      responseCheck: validateWorkflowDefinitionUpdateResponse,
    }),
    "workflow.definition.delete": Object.freeze({
      method: "workflow.definition.delete",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowDefinitionDeleteRequest,
      responseCheck: validateWorkflowDefinitionDeleteResponse,
    }),
    "workflow.definition.export": Object.freeze({
      method: "workflow.definition.export",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowDefinitionExportRequest,
      responseCheck: validateWorkflowDefinitionExportResponse,
    }),
    "workflow.definition.import": Object.freeze({
      method: "workflow.definition.import",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowDefinitionImportRequest,
      responseCheck: validateWorkflowDefinitionCreateResponse,
    }),
    "workflow.enabled.update": Object.freeze({
      method: "workflow.enabled.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowEnabledUpdateRequest,
      responseCheck: validateWorkflowEnabledUpdateResponse,
    }),
    "workflow.layout.update": Object.freeze({
      method: "workflow.layout.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowLayoutUpdateRequest,
      responseCheck: validateWorkflowDefinitionSettingResponse,
    }),
    "workflow.tags.update": Object.freeze({
      method: "workflow.tags.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowTagsUpdateRequest,
      responseCheck: validateWorkflowDefinitionSettingResponse,
    }),
    "workflow.permissionLevel.update": Object.freeze({
      method: "workflow.permissionLevel.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowPermissionLevelUpdateRequest,
      responseCheck: validateWorkflowPermissionLevelUpdateResponse,
    }),
    "workflow.backgroundBrowser.update": Object.freeze({
      method: "workflow.backgroundBrowser.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowBackgroundBrowserUpdateRequest,
      responseCheck: validateWorkflowBackgroundBrowserUpdateResponse,
    }),
    "workflow.provider.update": Object.freeze({
      method: "workflow.provider.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowProviderUpdateRequest,
      responseCheck: validateWorkflowProviderUpdateResponse,
    }),
    "workflow.pinData.update": Object.freeze({
      method: "workflow.pinData.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowPinDataUpdateRequest,
      responseCheck: validateWorkflowPinDataUpdateResponse,
    }),
    "workflow.draft.update": Object.freeze({
      method: "workflow.draft.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowDraftUpdateRequest,
      responseCheck: validateWorkflowDraftUpdateResponse,
    }),
    "workflow.draft.read": Object.freeze({
      method: "workflow.draft.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateWorkflowDraftReadRequest,
      responseCheck: validateWorkflowDraftReadResponse,
    }),
    "workflow.expression.preview": Object.freeze({
      method: "workflow.expression.preview",
      procedureType: "query",
      mutating: false,
      requestCheck: validateWorkflowExpressionPreviewRequest,
      responseCheck: validateWorkflowExpressionPreviewResponse,
    }),
    "workflow.version.diff.read": Object.freeze({
      method: "workflow.version.diff.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateWorkflowVersionDiffReadRequest,
      responseCheck: validateWorkflowVersionDiffReadResponse,
    }),
    "workflow.webhookToken.rotate": Object.freeze({
      method: "workflow.webhookToken.rotate",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWorkflowWebhookTokenRotateRequest,
      responseCheck: validateWorkflowWebhookTokenRotateResponse,
    }),
    "workflow.webhookListener.read": Object.freeze({
      method: "workflow.webhookListener.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateWorkflowWebhookListenerReadResponse,
    }),
  });
