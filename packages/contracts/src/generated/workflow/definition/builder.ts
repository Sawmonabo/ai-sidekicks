// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The state kept beside a workflow's versions, which saves no new version: the enabled switch, the canvas layout, the tags, the permission level, the background-browser pick, the provider pick, pinned test data, the builder's unsaved draft, the expression preview, and the webhook token and listener.

import { type CompiledSchemaCheck, deepEqual, ucs2length } from "../../../schema-check.js";
import {
  type Port,
  type WireInstant,
  validatePort,
  validateWireInstant,
} from "../../internal/wire-scalars.js";
import { type ProviderId, validateProviderId } from "../../provider/id.js";
import { type PermissionLevel, validatePermissionLevel } from "../../session/controls/methods.js";
import { type TagList, validateTagList } from "../../tag.js";
import {
  type WorkflowDefinitionId,
  type WorkflowDraftDocument,
  type WorkflowLayout,
  type WorkflowNodeId,
  validateWorkflowDefinitionId,
  validateWorkflowDraftDocument,
  validateWorkflowLayout,
  validateWorkflowNodeId,
} from "./document.js";
import { type WorkflowPinnedItem, validateWorkflowPinnedItem } from "./item.js";

/**
 * Wire members a reply-logging transport redacts before writing a record: the webhook token a
 * rotation shows once.
 */
export const WORKFLOW_WEBHOOK_TOKEN_REDACTED_WIRE_MEMBERS = ["token"] as const;

/**
 * The browser a workflow's runs use in the background, picked on the builder's browser pill: the
 * machine setting's choice, or sandboxed or not whatever that setting says. A new workflow reads
 * `settingsDefault`.
 */
export type WorkflowBackgroundBrowser = "settingsDefault" | "sandboxed" | "notSandboxed";
/**
 * The `workflow.draft.update` input: the builder's whole unsaved document, which replaces the one
 * held. The daemon holds one draft per saved workflow, named by `definitionId` with the version it
 * was opened from, and one for a new workflow, which omits both; saving the version clears it.
 */
export type WorkflowDraftUpdateRequest =
  | SavedWorkflowDraftUpdateRequest
  | NewWorkflowDraftUpdateRequest;
/**
 * One held draft: what the last update sent, and when it was stored.
 */
export type WorkflowDraft = SavedWorkflowDraft | NewWorkflowDraft;
/**
 * The `workflow.expression.preview` result: the value, or why the expression does not resolve
 * against that item.
 */
export type WorkflowExpressionPreviewResponse =
  | WorkflowExpressionResolved
  | WorkflowExpressionUnresolved;
/**
 * Whether the webhook listener listens.
 */
export type WorkflowWebhookListenerState = "listening" | "portTaken";

/**
 * The `workflow.enabled.update` input: arm or disarm every trigger of one workflow. A trigger that
 * cannot be armed refuses the switch with `workflow.trigger.unarmable`, and nothing turns on.
 */
export interface WorkflowEnabledUpdateRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * Whether its triggers are armed.
   */
  enabled: boolean;
}
/**
 * The `workflow.enabled.update` result: the switch's state and how many triggers are armed now,
 * none on a disarm; on an arm it is every trigger the workflow declares, since a partial arm
 * refuses.
 */
export interface WorkflowEnabledUpdateResponse {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * Whether its triggers are armed.
   */
  enabled: boolean;
  /**
   * How many triggers are armed now; 0 when `enabled` is false.
   */
  armedTriggerCount: number;
}
/**
 * The `workflow.layout.update` input: the whole canvas layout, saved on the definition without a
 * new version. Saved versions keep the layout they were written with.
 */
export interface WorkflowLayoutUpdateRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The layout.
   */
  layout: WorkflowLayout;
}
/**
 * When a setting kept beside the definition was stored; `workflow.layout.update` and
 * `workflow.tags.update` answer with it.
 */
export interface WorkflowDefinitionSettingResponse {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * When the setting was stored.
   */
  updatedAt: WireInstant;
}
/**
 * The `workflow.tags.update` input: the workflow's whole tag set, which replaces the one held, so
 * a remove and an add are one write. Tags sit outside the hashed body, so a change mints no
 * version; a tag that breaks the tag rule, or a repeat ignoring case, fails the parse.
 */
export interface WorkflowTagsUpdateRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The whole tag set.
   */
  tags: TagList;
}
/**
 * The `workflow.permissionLevel.update` input: the level every run of the workflow uses, a live
 * run from its next step. A new workflow starts at `yolo`; the level sits outside the hashed body,
 * so a change mints no version.
 */
export interface WorkflowPermissionLevelUpdateRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The level.
   */
  level: PermissionLevel;
}
/**
 * The level the workflow now runs at.
 */
export interface WorkflowPermissionLevelUpdateResponse {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The level.
   */
  level: PermissionLevel;
}
/**
 * The `workflow.backgroundBrowser.update` input: the background-browser pick every later run of
 * the workflow uses, a live run keeping the browser it started with. The pick sits outside the
 * hashed body, so a change mints no version.
 */
export interface WorkflowBackgroundBrowserUpdateRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The pick.
   */
  pick: WorkflowBackgroundBrowser;
}
/**
 * The background-browser pick the workflow's runs now use.
 */
export interface WorkflowBackgroundBrowserUpdateResponse {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The pick.
   */
  pick: WorkflowBackgroundBrowser;
}
/**
 * The `workflow.provider.update` input: the provider whose sandbox and shell every run of the
 * workflow uses for its command steps, read when a run starts. The pick sits outside the hashed
 * body, so a change mints no version.
 */
export interface WorkflowProviderUpdateRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The provider.
   */
  provider: ProviderId;
}
/**
 * The provider the workflow's runs now start with.
 */
export interface WorkflowProviderUpdateResponse {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The provider.
   */
  provider: ProviderId;
}
/**
 * The `workflow.pinData.update` input: pin items onto one node as test data, or unpin with `null`,
 * without a new version. Pinned data is honored only in manual runs.
 */
export interface WorkflowPinDataUpdateRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * The items to pin, or `null` to unpin.
   */
  items: WorkflowPinnedItem[] | null;
}
/**
 * The `workflow.pinData.update` result: whether the node is pinned now.
 */
export interface WorkflowPinDataUpdateResponse {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Whether it is pinned.
   */
  pinned: boolean;
}
/**
 * A saved workflow's draft as `workflow.draft.update` sends it.
 */
export interface SavedWorkflowDraftUpdateRequest {
  /**
   * The saved workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version the builder opened.
   */
  basedOnVersionNumber?: number;
  /**
   * The whole unsaved document.
   */
  document: WorkflowDraftDocument;
}
/**
 * The new workflow's draft as `workflow.draft.update` sends it.
 */
export interface NewWorkflowDraftUpdateRequest {
  /**
   * Never present: a new workflow has no definition yet.
   */
  definitionId?: never;
  /**
   * Never present: a new workflow has no version.
   */
  basedOnVersionNumber?: never;
  /**
   * The whole unsaved document.
   */
  document: WorkflowDraftDocument;
}
/**
 * When the daemon stored the draft.
 */
export interface WorkflowDraftUpdateResponse {
  /**
   * When it was stored.
   */
  updatedAt: WireInstant;
}
/**
 * The `workflow.draft.read` input: the draft of the workflow the builder's address names, or, with
 * no `definitionId`, the new workflow's draft. A reload reads it back this way.
 */
export interface WorkflowDraftReadRequest {
  /**
   * The saved workflow; absent for the new workflow's draft.
   */
  definitionId?: WorkflowDefinitionId;
}
/**
 * A saved workflow's held draft: what the last update sent, and when it was stored.
 */
export interface SavedWorkflowDraft {
  /**
   * The saved workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version the builder opened.
   */
  basedOnVersionNumber?: number;
  /**
   * The whole unsaved document.
   */
  document: WorkflowDraftDocument;
  /**
   * When the daemon stored it.
   */
  updatedAt: WireInstant;
}
/**
 * The new workflow's held draft: what the last update sent, and when it was stored.
 */
export interface NewWorkflowDraft {
  /**
   * Never present: a new workflow has no definition yet.
   */
  definitionId?: never;
  /**
   * Never present: a new workflow has no version.
   */
  basedOnVersionNumber?: never;
  /**
   * The whole unsaved document.
   */
  document: WorkflowDraftDocument;
  /**
   * When the daemon stored it.
   */
  updatedAt: WireInstant;
}
/**
 * The `workflow.draft.read` result. A draft that is no longer held is an answer, `null`, not an
 * error.
 */
export interface WorkflowDraftReadResponse {
  /**
   * The held draft, or `null`.
   */
  draft: WorkflowDraft | null;
}
/**
 * The `workflow.expression.preview` input: one expression of one node, evaluated in the daemon
 * against an item of the last run, the node read from the held draft, else the latest saved
 * version, or with no `definitionId` the new workflow's draft. It never resolves a secret: a
 * sensitive field previews the secret's name.
 */
export interface WorkflowExpressionPreviewRequest {
  /**
   * The workflow the expression sits in; absent for a new workflow.
   */
  definitionId?: WorkflowDefinitionId;
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * The expression.
   */
  expression: string;
  /**
   * The zero-based index of the item the inspector's data panels show.
   */
  itemIndex?: number;
}
/**
 * An expression that resolved against the item: its value.
 */
export interface WorkflowExpressionResolved {
  /**
   * Always `true`.
   */
  ok: true;
  /**
   * The value.
   */
  value: unknown;
  /**
   * Never present: a resolved expression has no failure.
   */
  reason?: never;
}
/**
 * An expression that does not resolve against the item: why, in words the field shows in place
 * of a value.
 */
export interface WorkflowExpressionUnresolved {
  /**
   * Always `false`.
   */
  ok: false;
  /**
   * Never present: an unresolved expression has no value.
   */
  value?: never;
  /**
   * Why it does not resolve.
   */
  reason: string;
}
/**
 * The `workflow.webhookToken.rotate` input: create the workflow's webhook token, or replace it.
 * The old token is refused from that moment.
 */
export interface WorkflowWebhookTokenRotateRequest {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
}
/**
 * The `workflow.webhookToken.rotate` result: the new token, shown once. Only its hash is kept, so
 * no later read returns it.
 */
export interface WorkflowWebhookTokenRotateResponse {
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The token.
   */
  token: string;
  /**
   * When it was made.
   */
  createdAt: WireInstant;
}
/**
 * The `workflow.webhookListener.read` result: the one loopback port the listener binds, and
 * whether it listens.
 */
export interface WorkflowWebhookListenerReadResponse {
  /**
   * The port.
   */
  port: Port;
  /**
   * Whether it listens.
   */
  state: WorkflowWebhookListenerState;
}

/** Checks that a value is a {@link WorkflowEnabledUpdateRequest}. */
// prettier-ignore
export const validateWorkflowEnabledUpdateRequest: CompiledSchemaCheck<WorkflowEnabledUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowEnabledUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowEnabledUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.enabled === undefined) && (missing0 = "enabled"))){validateWorkflowEnabledUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitionId") || (key0 === "enabled"))){validateWorkflowEnabledUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.enabled !== undefined){const _errs3: any = errors;if(typeof data.enabled !== "boolean"){validateWorkflowEnabledUpdateRequest.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowEnabledUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowEnabledUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowEnabledUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowEnabledUpdateResponse}. */
// prettier-ignore
export const validateWorkflowEnabledUpdateResponse: CompiledSchemaCheck<WorkflowEnabledUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowEnabledUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowEnabledUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = true;const _errs2: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){if(data.enabled !== undefined){if(false !== data.enabled){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}}var _valid0: any = _errs2 === errors;errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}if(_valid0){const _errs4: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){if(data.armedTriggerCount !== undefined){if(0 !== data.armedTriggerCount){validateWorkflowEnabledUpdateResponse.errors = [{instancePath:instancePath+"/armedTriggerCount",schemaPath:"#/then/properties/armedTriggerCount/const",keyword:"const",params:{allowedValue: 0}}];return false;}}}var _valid0: any = _errs4 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.armedTriggerCount = true;props0.enabled = true;}}if(!valid0){const err1: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: "then"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateWorkflowEnabledUpdateResponse.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.enabled === undefined) && (missing0 = "enabled"))) || ((data.armedTriggerCount === undefined) && (missing0 = "armedTriggerCount"))){validateWorkflowEnabledUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs6: any = errors;for(const key0 in data){if(!(((key0 === "definitionId") || (key0 === "enabled")) || (key0 === "armedTriggerCount"))){validateWorkflowEnabledUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs6 === errors){if(data.definitionId !== undefined){const _errs7: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid3: any = _errs7 === errors;}else {var valid3: any = true;}if(valid3){if(data.enabled !== undefined){const _errs8: any = errors;if(typeof data.enabled !== "boolean"){validateWorkflowEnabledUpdateResponse.errors = [{instancePath:instancePath+"/enabled",schemaPath:"#/properties/enabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid3: any = _errs8 === errors;}else {var valid3: any = true;}if(valid3){if(data.armedTriggerCount !== undefined){let data4: any = data.armedTriggerCount;const _errs10: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateWorkflowEnabledUpdateResponse.errors = [{instancePath:instancePath+"/armedTriggerCount",schemaPath:"#/properties/armedTriggerCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateWorkflowEnabledUpdateResponse.errors = [{instancePath:instancePath+"/armedTriggerCount",schemaPath:"#/properties/armedTriggerCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validateWorkflowEnabledUpdateResponse.errors = [{instancePath:instancePath+"/armedTriggerCount",schemaPath:"#/properties/armedTriggerCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid3: any = _errs10 === errors;}else {var valid3: any = true;}}}}}}else {validateWorkflowEnabledUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowEnabledUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowEnabledUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link WorkflowLayoutUpdateRequest}. */
// prettier-ignore
export const validateWorkflowLayoutUpdateRequest: CompiledSchemaCheck<WorkflowLayoutUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowLayoutUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowLayoutUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.layout === undefined) && (missing0 = "layout"))){validateWorkflowLayoutUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitionId") || (key0 === "layout"))){validateWorkflowLayoutUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.layout !== undefined){const _errs3: any = errors;if(!(validateWorkflowLayout.call(this, data.layout, {instancePath:instancePath+"/layout",parentData:data,parentDataProperty:"layout",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowLayout.errors : vErrors.concat(validateWorkflowLayout.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowLayoutUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowLayoutUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowLayoutUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDefinitionSettingResponse}. */
// prettier-ignore
export const validateWorkflowDefinitionSettingResponse: CompiledSchemaCheck<WorkflowDefinitionSettingResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionSettingResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionSettingResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.updatedAt === undefined) && (missing0 = "updatedAt"))){validateWorkflowDefinitionSettingResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitionId") || (key0 === "updatedAt"))){validateWorkflowDefinitionSettingResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.updatedAt !== undefined){const _errs3: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowDefinitionSettingResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDefinitionSettingResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionSettingResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowTagsUpdateRequest}. */
// prettier-ignore
export const validateWorkflowTagsUpdateRequest: CompiledSchemaCheck<WorkflowTagsUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowTagsUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowTagsUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.tags === undefined) && (missing0 = "tags"))){validateWorkflowTagsUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitionId") || (key0 === "tags"))){validateWorkflowTagsUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.tags !== undefined){const _errs3: any = errors;if(!(validateTagList.call(this, data.tags, {instancePath:instancePath+"/tags",parentData:data,parentDataProperty:"tags",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTagList.errors : vErrors.concat(validateTagList.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowTagsUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowTagsUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowTagsUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowPermissionLevelUpdateRequest}. */
// prettier-ignore
export const validateWorkflowPermissionLevelUpdateRequest: CompiledSchemaCheck<WorkflowPermissionLevelUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowPermissionLevelUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowPermissionLevelUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.level === undefined) && (missing0 = "level"))){validateWorkflowPermissionLevelUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitionId") || (key0 === "level"))){validateWorkflowPermissionLevelUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.level !== undefined){const _errs3: any = errors;if(!(validatePermissionLevel.call(this, data.level, {instancePath:instancePath+"/level",parentData:data,parentDataProperty:"level",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePermissionLevel.errors : vErrors.concat(validatePermissionLevel.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowPermissionLevelUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowPermissionLevelUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowPermissionLevelUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowPermissionLevelUpdateResponse}. */
// prettier-ignore
export const validateWorkflowPermissionLevelUpdateResponse: CompiledSchemaCheck<WorkflowPermissionLevelUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowPermissionLevelUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowPermissionLevelUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.level === undefined) && (missing0 = "level"))){validateWorkflowPermissionLevelUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitionId") || (key0 === "level"))){validateWorkflowPermissionLevelUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.level !== undefined){const _errs3: any = errors;if(!(validatePermissionLevel.call(this, data.level, {instancePath:instancePath+"/level",parentData:data,parentDataProperty:"level",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePermissionLevel.errors : vErrors.concat(validatePermissionLevel.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowPermissionLevelUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowPermissionLevelUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowPermissionLevelUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1408: any = {"description":"The browser a workflow's runs use in the background, picked on the builder's browser pill: the\nmachine setting's choice, or sandboxed or not whatever that setting says. A new workflow reads\n`settingsDefault`.","type":"string","enum":["settingsDefault","sandboxed","notSandboxed"]};
/** Checks that a value is a {@link WorkflowBackgroundBrowser}. */
// prettier-ignore
export const validateWorkflowBackgroundBrowser: CompiledSchemaCheck<WorkflowBackgroundBrowser> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowBackgroundBrowser {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowBackgroundBrowser.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowBackgroundBrowser.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "settingsDefault") || (data === "sandboxed")) || (data === "notSandboxed"))){validateWorkflowBackgroundBrowser.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1408.enum}}];return false;}validateWorkflowBackgroundBrowser.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowBackgroundBrowser.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowBackgroundBrowserUpdateRequest}. */
// prettier-ignore
export const validateWorkflowBackgroundBrowserUpdateRequest: CompiledSchemaCheck<WorkflowBackgroundBrowserUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowBackgroundBrowserUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowBackgroundBrowserUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.pick === undefined) && (missing0 = "pick"))){validateWorkflowBackgroundBrowserUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitionId") || (key0 === "pick"))){validateWorkflowBackgroundBrowserUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pick !== undefined){const _errs3: any = errors;if(!(validateWorkflowBackgroundBrowser.call(this, data.pick, {instancePath:instancePath+"/pick",parentData:data,parentDataProperty:"pick",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowBackgroundBrowser.errors : vErrors.concat(validateWorkflowBackgroundBrowser.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowBackgroundBrowserUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowBackgroundBrowserUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowBackgroundBrowserUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowBackgroundBrowserUpdateResponse}. */
// prettier-ignore
export const validateWorkflowBackgroundBrowserUpdateResponse: CompiledSchemaCheck<WorkflowBackgroundBrowserUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowBackgroundBrowserUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowBackgroundBrowserUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.pick === undefined) && (missing0 = "pick"))){validateWorkflowBackgroundBrowserUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitionId") || (key0 === "pick"))){validateWorkflowBackgroundBrowserUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pick !== undefined){const _errs3: any = errors;if(!(validateWorkflowBackgroundBrowser.call(this, data.pick, {instancePath:instancePath+"/pick",parentData:data,parentDataProperty:"pick",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowBackgroundBrowser.errors : vErrors.concat(validateWorkflowBackgroundBrowser.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowBackgroundBrowserUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowBackgroundBrowserUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowBackgroundBrowserUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowProviderUpdateRequest}. */
// prettier-ignore
export const validateWorkflowProviderUpdateRequest: CompiledSchemaCheck<WorkflowProviderUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowProviderUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowProviderUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.provider === undefined) && (missing0 = "provider"))){validateWorkflowProviderUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitionId") || (key0 === "provider"))){validateWorkflowProviderUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){const _errs3: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowProviderUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowProviderUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowProviderUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowProviderUpdateResponse}. */
// prettier-ignore
export const validateWorkflowProviderUpdateResponse: CompiledSchemaCheck<WorkflowProviderUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowProviderUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowProviderUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.provider === undefined) && (missing0 = "provider"))){validateWorkflowProviderUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "definitionId") || (key0 === "provider"))){validateWorkflowProviderUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){const _errs3: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowProviderUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowProviderUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowProviderUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1444: any = {"type":"object","additionalProperties":false,"properties":{"definitionId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId","description":"The workflow."},"nodeId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId","description":"The node."},"items":{"type":["array","null"],"items":{"$ref":"sidekicks-contracts:workflow/definition/item#/$defs/WorkflowPinnedItem"},"description":"The items to pin, or `null` to unpin."}},"required":["definitionId","nodeId","items"],"description":"The `workflow.pinData.update` input: pin items onto one node as test data, or unpin with `null`,\nwithout a new version. Pinned data is honored only in manual runs."};
/** Checks that a value is a {@link WorkflowPinDataUpdateRequest}. */
// prettier-ignore
export const validateWorkflowPinDataUpdateRequest: CompiledSchemaCheck<WorkflowPinDataUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowPinDataUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowPinDataUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.nodeId === undefined) && (missing0 = "nodeId"))) || ((data.items === undefined) && (missing0 = "items"))){validateWorkflowPinDataUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "definitionId") || (key0 === "nodeId")) || (key0 === "items"))){validateWorkflowPinDataUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){const _errs3: any = errors;if(!(validateWorkflowNodeId.call(this, data.nodeId, {instancePath:instancePath+"/nodeId",parentData:data,parentDataProperty:"nodeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.items !== undefined){let data2: any = data.items;const _errs4: any = errors;if((!(Array.isArray(data2))) && (data2 !== null)){validateWorkflowPinDataUpdateRequest.errors = [{instancePath:instancePath+"/items",schemaPath:"#/properties/items/type",keyword:"type",params:{type: schema1444.properties.items.type}}];return false;}if(errors === _errs4){if(Array.isArray(data2)){var valid1: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs6: any = errors;if(!(validateWorkflowPinnedItem.call(this, data2[i0], {instancePath:instancePath+"/items/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowPinnedItem.errors : vErrors.concat(validateWorkflowPinnedItem.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;if(!valid1){break;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowPinDataUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowPinDataUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowPinDataUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowPinDataUpdateResponse}. */
// prettier-ignore
export const validateWorkflowPinDataUpdateResponse: CompiledSchemaCheck<WorkflowPinDataUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowPinDataUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowPinDataUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.nodeId === undefined) && (missing0 = "nodeId"))) || ((data.pinned === undefined) && (missing0 = "pinned"))){validateWorkflowPinDataUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "definitionId") || (key0 === "nodeId")) || (key0 === "pinned"))){validateWorkflowPinDataUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){const _errs3: any = errors;if(!(validateWorkflowNodeId.call(this, data.nodeId, {instancePath:instancePath+"/nodeId",parentData:data,parentDataProperty:"nodeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.pinned !== undefined){const _errs4: any = errors;if(typeof data.pinned !== "boolean"){validateWorkflowPinDataUpdateResponse.errors = [{instancePath:instancePath+"/pinned",schemaPath:"#/properties/pinned/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowPinDataUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowPinDataUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowPinDataUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SavedWorkflowDraftUpdateRequest}. */
// prettier-ignore
export const validateSavedWorkflowDraftUpdateRequest: CompiledSchemaCheck<SavedWorkflowDraftUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SavedWorkflowDraftUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSavedWorkflowDraftUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.document === undefined) && (missing0 = "document"))){validateSavedWorkflowDraftUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "definitionId") || (key0 === "basedOnVersionNumber")) || (key0 === "document"))){validateSavedWorkflowDraftUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.basedOnVersionNumber !== undefined){let data1: any = data.basedOnVersionNumber;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateSavedWorkflowDraftUpdateRequest.errors = [{instancePath:instancePath+"/basedOnVersionNumber",schemaPath:"#/properties/basedOnVersionNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateSavedWorkflowDraftUpdateRequest.errors = [{instancePath:instancePath+"/basedOnVersionNumber",schemaPath:"#/properties/basedOnVersionNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateSavedWorkflowDraftUpdateRequest.errors = [{instancePath:instancePath+"/basedOnVersionNumber",schemaPath:"#/properties/basedOnVersionNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.document !== undefined){const _errs5: any = errors;if(!(validateWorkflowDraftDocument.call(this, data.document, {instancePath:instancePath+"/document",parentData:data,parentDataProperty:"document",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDraftDocument.errors : vErrors.concat(validateWorkflowDraftDocument.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateSavedWorkflowDraftUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSavedWorkflowDraftUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSavedWorkflowDraftUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link NewWorkflowDraftUpdateRequest}. */
// prettier-ignore
export const validateNewWorkflowDraftUpdateRequest: CompiledSchemaCheck<NewWorkflowDraftUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is NewWorkflowDraftUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateNewWorkflowDraftUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.document === undefined) && (missing0 = "document")){validateNewWorkflowDraftUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "definitionId") || (key0 === "basedOnVersionNumber")) || (key0 === "document"))){validateNewWorkflowDraftUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;validateNewWorkflowDraftUpdateRequest.errors = [{instancePath:instancePath+"/definitionId",schemaPath:"#/properties/definitionId/not",keyword:"not",params:{}}];return false;var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.basedOnVersionNumber !== undefined){const _errs5: any = errors;validateNewWorkflowDraftUpdateRequest.errors = [{instancePath:instancePath+"/basedOnVersionNumber",schemaPath:"#/properties/basedOnVersionNumber/not",keyword:"not",params:{}}];return false;var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.document !== undefined){const _errs8: any = errors;if(!(validateWorkflowDraftDocument.call(this, data.document, {instancePath:instancePath+"/document",parentData:data,parentDataProperty:"document",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDraftDocument.errors : vErrors.concat(validateWorkflowDraftDocument.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validateNewWorkflowDraftUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateNewWorkflowDraftUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateNewWorkflowDraftUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDraftUpdateRequest}. */
// prettier-ignore
export const validateWorkflowDraftUpdateRequest: CompiledSchemaCheck<WorkflowDraftUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDraftUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDraftUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validateSavedWorkflowDraftUpdateRequest.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSavedWorkflowDraftUpdateRequest.errors : vErrors.concat(validateSavedWorkflowDraftUpdateRequest.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs2: any = errors;if(!(validateNewWorkflowDraftUpdateRequest.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateNewWorkflowDraftUpdateRequest.errors : vErrors.concat(validateNewWorkflowDraftUpdateRequest.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validateWorkflowDraftUpdateRequest.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateWorkflowDraftUpdateRequest.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateWorkflowDraftUpdateRequest.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDraftUpdateResponse}. */
// prettier-ignore
export const validateWorkflowDraftUpdateResponse: CompiledSchemaCheck<WorkflowDraftUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDraftUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDraftUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.updatedAt === undefined) && (missing0 = "updatedAt")){validateWorkflowDraftUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "updatedAt")){validateWorkflowDraftUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.updatedAt !== undefined){if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}}}}}else {validateWorkflowDraftUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDraftUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDraftUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDraftReadRequest}. */
// prettier-ignore
export const validateWorkflowDraftReadRequest: CompiledSchemaCheck<WorkflowDraftReadRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDraftReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDraftReadRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!(key0 === "definitionId")){validateWorkflowDraftReadRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}}}}else {validateWorkflowDraftReadRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDraftReadRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDraftReadRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SavedWorkflowDraft}. */
// prettier-ignore
export const validateSavedWorkflowDraft: CompiledSchemaCheck<SavedWorkflowDraft> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SavedWorkflowDraft {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSavedWorkflowDraft.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.document === undefined) && (missing0 = "document"))) || ((data.updatedAt === undefined) && (missing0 = "updatedAt"))){validateSavedWorkflowDraft.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "definitionId") || (key0 === "basedOnVersionNumber")) || (key0 === "document")) || (key0 === "updatedAt"))){validateSavedWorkflowDraft.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.basedOnVersionNumber !== undefined){let data1: any = data.basedOnVersionNumber;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateSavedWorkflowDraft.errors = [{instancePath:instancePath+"/basedOnVersionNumber",schemaPath:"#/properties/basedOnVersionNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateSavedWorkflowDraft.errors = [{instancePath:instancePath+"/basedOnVersionNumber",schemaPath:"#/properties/basedOnVersionNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateSavedWorkflowDraft.errors = [{instancePath:instancePath+"/basedOnVersionNumber",schemaPath:"#/properties/basedOnVersionNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.document !== undefined){const _errs5: any = errors;if(!(validateWorkflowDraftDocument.call(this, data.document, {instancePath:instancePath+"/document",parentData:data,parentDataProperty:"document",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDraftDocument.errors : vErrors.concat(validateWorkflowDraftDocument.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.updatedAt !== undefined){const _errs6: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateSavedWorkflowDraft.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSavedWorkflowDraft.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSavedWorkflowDraft.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link NewWorkflowDraft}. */
// prettier-ignore
export const validateNewWorkflowDraft: CompiledSchemaCheck<NewWorkflowDraft> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is NewWorkflowDraft {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateNewWorkflowDraft.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.document === undefined) && (missing0 = "document")) || ((data.updatedAt === undefined) && (missing0 = "updatedAt"))){validateNewWorkflowDraft.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "definitionId") || (key0 === "basedOnVersionNumber")) || (key0 === "document")) || (key0 === "updatedAt"))){validateNewWorkflowDraft.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;validateNewWorkflowDraft.errors = [{instancePath:instancePath+"/definitionId",schemaPath:"#/properties/definitionId/not",keyword:"not",params:{}}];return false;var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.basedOnVersionNumber !== undefined){const _errs5: any = errors;validateNewWorkflowDraft.errors = [{instancePath:instancePath+"/basedOnVersionNumber",schemaPath:"#/properties/basedOnVersionNumber/not",keyword:"not",params:{}}];return false;var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.document !== undefined){const _errs8: any = errors;if(!(validateWorkflowDraftDocument.call(this, data.document, {instancePath:instancePath+"/document",parentData:data,parentDataProperty:"document",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDraftDocument.errors : vErrors.concat(validateWorkflowDraftDocument.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.updatedAt !== undefined){const _errs9: any = errors;if(!(validateWireInstant.call(this, data.updatedAt, {instancePath:instancePath+"/updatedAt",parentData:data,parentDataProperty:"updatedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}}else {validateNewWorkflowDraft.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateNewWorkflowDraft.errors = vErrors;return errors === 0;};
// prettier-ignore
validateNewWorkflowDraft.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDraft}. */
// prettier-ignore
export const validateWorkflowDraft: CompiledSchemaCheck<WorkflowDraft> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDraft {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDraft.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validateSavedWorkflowDraft.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSavedWorkflowDraft.errors : vErrors.concat(validateSavedWorkflowDraft.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs2: any = errors;if(!(validateNewWorkflowDraft.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateNewWorkflowDraft.errors : vErrors.concat(validateNewWorkflowDraft.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validateWorkflowDraft.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateWorkflowDraft.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateWorkflowDraft.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowDraftReadResponse}. */
// prettier-ignore
export const validateWorkflowDraftReadResponse: CompiledSchemaCheck<WorkflowDraftReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDraftReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDraftReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.draft === undefined) && (missing0 = "draft")){validateWorkflowDraftReadResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "draft")){validateWorkflowDraftReadResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.draft !== undefined){let data0: any = data.draft;const _errs3: any = errors;let valid1: any = false;const _errs4: any = errors;if(!(validateWorkflowDraft.call(this, data0, {instancePath:instancePath+"/draft",parentData:data,parentDataProperty:"draft",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDraft.errors : vErrors.concat(validateWorkflowDraft.errors);errors = vErrors.length;}var _valid0: any = _errs4 === errors;valid1 = valid1 || _valid0;const _errs5: any = errors;if(data0 !== null){const err0: any = {instancePath:instancePath+"/draft",schemaPath:"#/properties/draft/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs5 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/draft",schemaPath:"#/properties/draft/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateWorkflowDraftReadResponse.errors = vErrors;return false;}else {errors = _errs3;if(vErrors !== null){if(_errs3){vErrors.length = _errs3;}else {vErrors = null;}}}}}}}else {validateWorkflowDraftReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDraftReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDraftReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowExpressionPreviewRequest}. */
// prettier-ignore
export const validateWorkflowExpressionPreviewRequest: CompiledSchemaCheck<WorkflowExpressionPreviewRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowExpressionPreviewRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowExpressionPreviewRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.nodeId === undefined) && (missing0 = "nodeId")) || ((data.expression === undefined) && (missing0 = "expression"))){validateWorkflowExpressionPreviewRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "definitionId") || (key0 === "nodeId")) || (key0 === "expression")) || (key0 === "itemIndex"))){validateWorkflowExpressionPreviewRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){const _errs3: any = errors;if(!(validateWorkflowNodeId.call(this, data.nodeId, {instancePath:instancePath+"/nodeId",parentData:data,parentDataProperty:"nodeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.expression !== undefined){let data2: any = data.expression;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) < 1){validateWorkflowExpressionPreviewRequest.errors = [{instancePath:instancePath+"/expression",schemaPath:"#/properties/expression/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowExpressionPreviewRequest.errors = [{instancePath:instancePath+"/expression",schemaPath:"#/properties/expression/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.itemIndex !== undefined){let data3: any = data.itemIndex;const _errs6: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateWorkflowExpressionPreviewRequest.errors = [{instancePath:instancePath+"/itemIndex",schemaPath:"#/properties/itemIndex/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateWorkflowExpressionPreviewRequest.errors = [{instancePath:instancePath+"/itemIndex",schemaPath:"#/properties/itemIndex/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateWorkflowExpressionPreviewRequest.errors = [{instancePath:instancePath+"/itemIndex",schemaPath:"#/properties/itemIndex/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateWorkflowExpressionPreviewRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowExpressionPreviewRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowExpressionPreviewRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowExpressionResolved}. */
// prettier-ignore
export const validateWorkflowExpressionResolved: CompiledSchemaCheck<WorkflowExpressionResolved> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowExpressionResolved {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowExpressionResolved.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.ok === undefined) && (missing0 = "ok")) || ((data.value === undefined) && (missing0 = "value"))){validateWorkflowExpressionResolved.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "ok") || (key0 === "value")) || (key0 === "reason"))){validateWorkflowExpressionResolved.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.ok !== undefined){let data0: any = data.ok;const _errs2: any = errors;if(typeof data0 !== "boolean"){validateWorkflowExpressionResolved.errors = [{instancePath:instancePath+"/ok",schemaPath:"#/properties/ok/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validateWorkflowExpressionResolved.errors = [{instancePath:instancePath+"/ok",schemaPath:"#/properties/ok/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.value !== undefined){const _errs4: any = errors;var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){const _errs6: any = errors;validateWorkflowExpressionResolved.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/not",keyword:"not",params:{}}];return false;var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowExpressionResolved.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowExpressionResolved.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowExpressionResolved.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowExpressionUnresolved}. */
// prettier-ignore
export const validateWorkflowExpressionUnresolved: CompiledSchemaCheck<WorkflowExpressionUnresolved> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowExpressionUnresolved {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowExpressionUnresolved.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.ok === undefined) && (missing0 = "ok")) || ((data.reason === undefined) && (missing0 = "reason"))){validateWorkflowExpressionUnresolved.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "ok") || (key0 === "value")) || (key0 === "reason"))){validateWorkflowExpressionUnresolved.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.ok !== undefined){let data0: any = data.ok;const _errs2: any = errors;if(typeof data0 !== "boolean"){validateWorkflowExpressionUnresolved.errors = [{instancePath:instancePath+"/ok",schemaPath:"#/properties/ok/type",keyword:"type",params:{type: "boolean"}}];return false;}if(false !== data0){validateWorkflowExpressionUnresolved.errors = [{instancePath:instancePath+"/ok",schemaPath:"#/properties/ok/const",keyword:"const",params:{allowedValue: false}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.value !== undefined){const _errs4: any = errors;validateWorkflowExpressionUnresolved.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/not",keyword:"not",params:{}}];return false;var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data2: any = data.reason;const _errs7: any = errors;if(errors === _errs7){if(typeof data2 === "string"){if(func1(data2) < 1){validateWorkflowExpressionUnresolved.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowExpressionUnresolved.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowExpressionUnresolved.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowExpressionUnresolved.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowExpressionUnresolved.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowExpressionPreviewResponse}. */
// prettier-ignore
export const validateWorkflowExpressionPreviewResponse: CompiledSchemaCheck<WorkflowExpressionPreviewResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowExpressionPreviewResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowExpressionPreviewResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validateWorkflowExpressionResolved.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowExpressionResolved.errors : vErrors.concat(validateWorkflowExpressionResolved.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs2: any = errors;if(!(validateWorkflowExpressionUnresolved.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowExpressionUnresolved.errors : vErrors.concat(validateWorkflowExpressionUnresolved.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validateWorkflowExpressionPreviewResponse.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateWorkflowExpressionPreviewResponse.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateWorkflowExpressionPreviewResponse.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowWebhookTokenRotateRequest}. */
// prettier-ignore
export const validateWorkflowWebhookTokenRotateRequest: CompiledSchemaCheck<WorkflowWebhookTokenRotateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowWebhookTokenRotateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowWebhookTokenRotateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.definitionId === undefined) && (missing0 = "definitionId")){validateWorkflowWebhookTokenRotateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "definitionId")){validateWorkflowWebhookTokenRotateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}}}}}else {validateWorkflowWebhookTokenRotateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowWebhookTokenRotateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowWebhookTokenRotateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowWebhookTokenRotateResponse}. */
// prettier-ignore
export const validateWorkflowWebhookTokenRotateResponse: CompiledSchemaCheck<WorkflowWebhookTokenRotateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowWebhookTokenRotateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowWebhookTokenRotateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.definitionId === undefined) && (missing0 = "definitionId")) || ((data.token === undefined) && (missing0 = "token"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))){validateWorkflowWebhookTokenRotateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "definitionId") || (key0 === "token")) || (key0 === "createdAt"))){validateWorkflowWebhookTokenRotateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.definitionId !== undefined){const _errs2: any = errors;if(!(validateWorkflowDefinitionId.call(this, data.definitionId, {instancePath:instancePath+"/definitionId",parentData:data,parentDataProperty:"definitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowDefinitionId.errors : vErrors.concat(validateWorkflowDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.token !== undefined){let data1: any = data.token;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validateWorkflowWebhookTokenRotateResponse.errors = [{instancePath:instancePath+"/token",schemaPath:"#/properties/token/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowWebhookTokenRotateResponse.errors = [{instancePath:instancePath+"/token",schemaPath:"#/properties/token/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.createdAt !== undefined){const _errs5: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowWebhookTokenRotateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowWebhookTokenRotateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowWebhookTokenRotateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1450: any = {"description":"Whether the webhook listener listens.","type":"string","enum":["listening","portTaken"]};
/** Checks that a value is a {@link WorkflowWebhookListenerState}. */
// prettier-ignore
export const validateWorkflowWebhookListenerState: CompiledSchemaCheck<WorkflowWebhookListenerState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowWebhookListenerState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowWebhookListenerState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowWebhookListenerState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "listening") || (data === "portTaken"))){validateWorkflowWebhookListenerState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1450.enum}}];return false;}validateWorkflowWebhookListenerState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowWebhookListenerState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowWebhookListenerReadResponse}. */
// prettier-ignore
export const validateWorkflowWebhookListenerReadResponse: CompiledSchemaCheck<WorkflowWebhookListenerReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowWebhookListenerReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowWebhookListenerReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.port === undefined) && (missing0 = "port")) || ((data.state === undefined) && (missing0 = "state"))){validateWorkflowWebhookListenerReadResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "port") || (key0 === "state"))){validateWorkflowWebhookListenerReadResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.port !== undefined){const _errs2: any = errors;if(!(validatePort.call(this, data.port, {instancePath:instancePath+"/port",parentData:data,parentDataProperty:"port",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePort.errors : vErrors.concat(validatePort.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs3: any = errors;if(!(validateWorkflowWebhookListenerState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowWebhookListenerState.errors : vErrors.concat(validateWorkflowWebhookListenerState.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowWebhookListenerReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowWebhookListenerReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowWebhookListenerReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
