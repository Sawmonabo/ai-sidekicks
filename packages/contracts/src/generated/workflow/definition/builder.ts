// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The state kept beside a workflow's versions, which saves no new version: the enabled switch, the canvas layout, the tags, the permission level, the background-browser pick, the provider pick, pinned test data, the builder's unsaved draft, the expression preview, and the webhook token and listener.

import type { Port, WireInstant } from "../../internal/wire-scalars.js";
import type { ProviderId } from "../../provider/id.js";
import type { PermissionLevel } from "../../session/controls/methods.js";
import type { TagList } from "../../tag.js";
import type {
  WorkflowDefinitionId,
  WorkflowDraftDocument,
  WorkflowLayout,
  WorkflowNodeId,
} from "./document.js";
import type { WorkflowPinnedItem } from "./item.js";

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

export {
  validateNewWorkflowDraft,
  validateNewWorkflowDraftUpdateRequest,
  validateSavedWorkflowDraft,
  validateSavedWorkflowDraftUpdateRequest,
  validateWorkflowBackgroundBrowser,
  validateWorkflowBackgroundBrowserUpdateRequest,
  validateWorkflowBackgroundBrowserUpdateResponse,
  validateWorkflowDefinitionSettingResponse,
  validateWorkflowDraft,
  validateWorkflowDraftReadRequest,
  validateWorkflowDraftReadResponse,
  validateWorkflowDraftUpdateRequest,
  validateWorkflowDraftUpdateResponse,
  validateWorkflowEnabledUpdateRequest,
  validateWorkflowEnabledUpdateResponse,
  validateWorkflowExpressionPreviewRequest,
  validateWorkflowExpressionPreviewResponse,
  validateWorkflowExpressionResolved,
  validateWorkflowExpressionUnresolved,
  validateWorkflowLayoutUpdateRequest,
  validateWorkflowPermissionLevelUpdateRequest,
  validateWorkflowPermissionLevelUpdateResponse,
  validateWorkflowPinDataUpdateRequest,
  validateWorkflowPinDataUpdateResponse,
  validateWorkflowProviderUpdateRequest,
  validateWorkflowProviderUpdateResponse,
  validateWorkflowTagsUpdateRequest,
  validateWorkflowWebhookListenerReadResponse,
  validateWorkflowWebhookListenerState,
  validateWorkflowWebhookTokenRotateRequest,
  validateWorkflowWebhookTokenRotateResponse,
} from "../../checks/workflow/definition/builder.js";
