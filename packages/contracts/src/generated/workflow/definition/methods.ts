// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `workflow.*` methods over definitions: create, read, list, update, delete, export and import, and the one method table for every definition method.

import type { WireInstant } from "../../internal/wire-scalars.js";
import type { EmptyPayload } from "../../method-descriptor.js";
import type { ProviderId } from "../../provider/id.js";
import type { PermissionLevel } from "../../session/controls/methods.js";
import type { TagList } from "../../tag.js";
import type { WorkflowRunId } from "../run/id.js";
import type { WorkflowRunStatus } from "../run/status.js";
import type {
  WorkflowBackgroundBrowser,
  WorkflowBackgroundBrowserUpdateRequest,
  WorkflowBackgroundBrowserUpdateResponse,
  WorkflowDefinitionSettingResponse,
  WorkflowDraftReadRequest,
  WorkflowDraftReadResponse,
  WorkflowDraftUpdateRequest,
  WorkflowDraftUpdateResponse,
  WorkflowEnabledUpdateRequest,
  WorkflowEnabledUpdateResponse,
  WorkflowExpressionPreviewRequest,
  WorkflowExpressionPreviewResponse,
  WorkflowLayoutUpdateRequest,
  WorkflowPermissionLevelUpdateRequest,
  WorkflowPermissionLevelUpdateResponse,
  WorkflowPinDataUpdateRequest,
  WorkflowPinDataUpdateResponse,
  WorkflowProviderUpdateRequest,
  WorkflowProviderUpdateResponse,
  WorkflowTagsUpdateRequest,
  WorkflowWebhookListenerReadResponse,
  WorkflowWebhookTokenRotateRequest,
  WorkflowWebhookTokenRotateResponse,
} from "./builder.js";
import type {
  WorkflowContentHash,
  WorkflowDefinitionId,
  WorkflowDocument,
  WorkflowNodeKindId,
  WorkflowVersionId,
} from "./document.js";
import type {
  WorkflowVersionDiffReadRequest,
  WorkflowVersionDiffReadResponse,
  WorkflowVersionListRequest,
  WorkflowVersionListResponse,
  WorkflowVersionReadRequest,
  WorkflowVersionReadResponse,
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

/** The methods of {@link WORKFLOW_DEFINITION_METHOD_DESCRIPTORS}, each with its kind. */
export interface WorkflowDefinitionMethodDescriptors {
  readonly "workflow.definition.create": {
    readonly method: "workflow.definition.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.definition.read": {
    readonly method: "workflow.definition.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "workflow.definition.list": {
    readonly method: "workflow.definition.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "workflow.version.read": {
    readonly method: "workflow.version.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "workflow.version.list": {
    readonly method: "workflow.version.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "workflow.definition.update": {
    readonly method: "workflow.definition.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.definition.delete": {
    readonly method: "workflow.definition.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.definition.export": {
    readonly method: "workflow.definition.export";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.definition.import": {
    readonly method: "workflow.definition.import";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.enabled.update": {
    readonly method: "workflow.enabled.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.layout.update": {
    readonly method: "workflow.layout.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.tags.update": {
    readonly method: "workflow.tags.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.permissionLevel.update": {
    readonly method: "workflow.permissionLevel.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.backgroundBrowser.update": {
    readonly method: "workflow.backgroundBrowser.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.provider.update": {
    readonly method: "workflow.provider.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.pinData.update": {
    readonly method: "workflow.pinData.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.draft.update": {
    readonly method: "workflow.draft.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.draft.read": {
    readonly method: "workflow.draft.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "workflow.expression.preview": {
    readonly method: "workflow.expression.preview";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "workflow.version.diff.read": {
    readonly method: "workflow.version.diff.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "workflow.webhookToken.rotate": {
    readonly method: "workflow.webhookToken.rotate";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.webhookListener.read": {
    readonly method: "workflow.webhookListener.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link WORKFLOW_DEFINITION_METHOD_DESCRIPTORS}. */
export interface WorkflowDefinitionMethodTypes {
  readonly "workflow.definition.create": {
    readonly params: WorkflowDefinitionCreateRequest;
    readonly result: WorkflowDefinitionCreateResponse;
  };
  readonly "workflow.definition.read": {
    readonly params: WorkflowDefinitionReadRequest;
    readonly result: WorkflowDefinitionReadResponse;
  };
  readonly "workflow.definition.list": {
    readonly params: WorkflowDefinitionListRequest;
    readonly result: WorkflowDefinitionListResponse;
  };
  readonly "workflow.version.read": {
    readonly params: WorkflowVersionReadRequest;
    readonly result: WorkflowVersionReadResponse;
  };
  readonly "workflow.version.list": {
    readonly params: WorkflowVersionListRequest;
    readonly result: WorkflowVersionListResponse;
  };
  readonly "workflow.definition.update": {
    readonly params: WorkflowDefinitionUpdateRequest;
    readonly result: WorkflowDefinitionUpdateResponse;
  };
  readonly "workflow.definition.delete": {
    readonly params: WorkflowDefinitionDeleteRequest;
    readonly result: WorkflowDefinitionDeleteResponse;
  };
  readonly "workflow.definition.export": {
    readonly params: WorkflowDefinitionExportRequest;
    readonly result: WorkflowDefinitionExportResponse;
  };
  readonly "workflow.definition.import": {
    readonly params: WorkflowDefinitionImportRequest;
    readonly result: WorkflowDefinitionCreateResponse;
  };
  readonly "workflow.enabled.update": {
    readonly params: WorkflowEnabledUpdateRequest;
    readonly result: WorkflowEnabledUpdateResponse;
  };
  readonly "workflow.layout.update": {
    readonly params: WorkflowLayoutUpdateRequest;
    readonly result: WorkflowDefinitionSettingResponse;
  };
  readonly "workflow.tags.update": {
    readonly params: WorkflowTagsUpdateRequest;
    readonly result: WorkflowDefinitionSettingResponse;
  };
  readonly "workflow.permissionLevel.update": {
    readonly params: WorkflowPermissionLevelUpdateRequest;
    readonly result: WorkflowPermissionLevelUpdateResponse;
  };
  readonly "workflow.backgroundBrowser.update": {
    readonly params: WorkflowBackgroundBrowserUpdateRequest;
    readonly result: WorkflowBackgroundBrowserUpdateResponse;
  };
  readonly "workflow.provider.update": {
    readonly params: WorkflowProviderUpdateRequest;
    readonly result: WorkflowProviderUpdateResponse;
  };
  readonly "workflow.pinData.update": {
    readonly params: WorkflowPinDataUpdateRequest;
    readonly result: WorkflowPinDataUpdateResponse;
  };
  readonly "workflow.draft.update": {
    readonly params: WorkflowDraftUpdateRequest;
    readonly result: WorkflowDraftUpdateResponse;
  };
  readonly "workflow.draft.read": {
    readonly params: WorkflowDraftReadRequest;
    readonly result: WorkflowDraftReadResponse;
  };
  readonly "workflow.expression.preview": {
    readonly params: WorkflowExpressionPreviewRequest;
    readonly result: WorkflowExpressionPreviewResponse;
  };
  readonly "workflow.version.diff.read": {
    readonly params: WorkflowVersionDiffReadRequest;
    readonly result: WorkflowVersionDiffReadResponse;
  };
  readonly "workflow.webhookToken.rotate": {
    readonly params: WorkflowWebhookTokenRotateRequest;
    readonly result: WorkflowWebhookTokenRotateResponse;
  };
  readonly "workflow.webhookListener.read": {
    readonly params: EmptyPayload;
    readonly result: WorkflowWebhookListenerReadResponse;
  };
}
/**
 * The `workflow.*` methods over definitions: create, read, list, update, delete, export and
 * import, the version reads, and the settings, draft, expression preview and webhook kept
 * beside a workflow's versions.
 */
export const WORKFLOW_DEFINITION_METHOD_DESCRIPTORS: WorkflowDefinitionMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "workflow.definition.create": /* @__PURE__ */ Object.freeze({
      method: "workflow.definition.create",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.definition.read": /* @__PURE__ */ Object.freeze({
      method: "workflow.definition.read",
      procedureType: "query",
      mutating: false,
    }),
    "workflow.definition.list": /* @__PURE__ */ Object.freeze({
      method: "workflow.definition.list",
      procedureType: "query",
      mutating: false,
    }),
    "workflow.version.read": /* @__PURE__ */ Object.freeze({
      method: "workflow.version.read",
      procedureType: "query",
      mutating: false,
    }),
    "workflow.version.list": /* @__PURE__ */ Object.freeze({
      method: "workflow.version.list",
      procedureType: "query",
      mutating: false,
    }),
    "workflow.definition.update": /* @__PURE__ */ Object.freeze({
      method: "workflow.definition.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.definition.delete": /* @__PURE__ */ Object.freeze({
      method: "workflow.definition.delete",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.definition.export": /* @__PURE__ */ Object.freeze({
      method: "workflow.definition.export",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.definition.import": /* @__PURE__ */ Object.freeze({
      method: "workflow.definition.import",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.enabled.update": /* @__PURE__ */ Object.freeze({
      method: "workflow.enabled.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.layout.update": /* @__PURE__ */ Object.freeze({
      method: "workflow.layout.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.tags.update": /* @__PURE__ */ Object.freeze({
      method: "workflow.tags.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.permissionLevel.update": /* @__PURE__ */ Object.freeze({
      method: "workflow.permissionLevel.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.backgroundBrowser.update": /* @__PURE__ */ Object.freeze({
      method: "workflow.backgroundBrowser.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.provider.update": /* @__PURE__ */ Object.freeze({
      method: "workflow.provider.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.pinData.update": /* @__PURE__ */ Object.freeze({
      method: "workflow.pinData.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.draft.update": /* @__PURE__ */ Object.freeze({
      method: "workflow.draft.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.draft.read": /* @__PURE__ */ Object.freeze({
      method: "workflow.draft.read",
      procedureType: "query",
      mutating: false,
    }),
    "workflow.expression.preview": /* @__PURE__ */ Object.freeze({
      method: "workflow.expression.preview",
      procedureType: "query",
      mutating: false,
    }),
    "workflow.version.diff.read": /* @__PURE__ */ Object.freeze({
      method: "workflow.version.diff.read",
      procedureType: "query",
      mutating: false,
    }),
    "workflow.webhookToken.rotate": /* @__PURE__ */ Object.freeze({
      method: "workflow.webhookToken.rotate",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.webhookListener.read": /* @__PURE__ */ Object.freeze({
      method: "workflow.webhookListener.read",
      procedureType: "query",
      mutating: false,
    }),
  });
