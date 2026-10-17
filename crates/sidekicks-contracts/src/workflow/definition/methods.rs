//! The `workflow.*` methods over definitions: create, read, list, update, delete, export and
//! import, and the one method table for every definition method, the builder's settings, drafts and
//! webhook and the version reads among them.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::free_form_string::FilesystemPath;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::session::controls::methods::PermissionLevel;
use crate::tag::TagList;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::{NonEmptyText, branded_text};
use crate::wire::{Never, True};
use crate::workflow::definition::builder::{
    WorkflowBackgroundBrowser, WorkflowBackgroundBrowserUpdateRequest,
    WorkflowBackgroundBrowserUpdateResponse, WorkflowDefinitionSettingResponse,
    WorkflowDraftReadRequest, WorkflowDraftReadResponse, WorkflowDraftUpdateRequest,
    WorkflowDraftUpdateResponse, WorkflowEnabledUpdateRequest, WorkflowEnabledUpdateResponse,
    WorkflowExpressionPreviewRequest, WorkflowExpressionPreviewResponse,
    WorkflowLayoutUpdateRequest, WorkflowPermissionLevelUpdateRequest,
    WorkflowPermissionLevelUpdateResponse, WorkflowPinDataUpdateRequest,
    WorkflowPinDataUpdateResponse, WorkflowTagsUpdateRequest, WorkflowWebhookListenerReadResponse,
    WorkflowWebhookTokenRotateRequest, WorkflowWebhookTokenRotateResponse,
};
use crate::workflow::definition::document::{
    WorkflowContentHash, WorkflowDefinitionId, WorkflowDocument, WorkflowNodeKindId,
    WorkflowVersionId,
};
use crate::workflow::definition::versions::{
    WorkflowVersionDiffReadRequest, WorkflowVersionDiffReadResponse, WorkflowVersionListRequest,
    WorkflowVersionListResponse, WorkflowVersionReadRequest, WorkflowVersionReadResponse,
};
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::status::WorkflowRunStatus;

// workflow.definition.create

/// The `workflow.definition.create` input, which saving a new workflow, duplicating one and
/// importing a file all send. A name another workflow holds, compared ignoring case, is refused
/// with `workflow.definition.refused`, finding `name_taken`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionCreateRequest {
    /// The document.
    #[garde(dive)]
    pub document: WorkflowDocument,
}

/// The `workflow.definition.create` result: the new definition and its first version, with what a
/// caller needs to pin or start that version without a second read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionCreateResponse {
    /// The new workflow.
    pub definition_id: WorkflowDefinitionId,
    /// Its first version's number.
    pub version_number: SafeInt<1>,
    /// The hash of that version's hashed body.
    pub content_hash: WorkflowContentHash,
    /// That version's id, the one a run start takes.
    pub workflow_version_id: WorkflowVersionId,
    /// When it was saved.
    #[garde(dive)]
    pub created_at: WireInstant,
}

// workflow.definition.read

/// The `workflow.definition.read` input: one definition, at `version` when given and at its latest
/// version otherwise. A deleted definition still reads; only one never created is refused
/// `workflow.not_found`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionReadRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The version's number; absent for the latest.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<1>")]
    pub version: Option<SafeInt<1>>,
}

/// What a webhook fire came to: a run started, skipped because a run was still going, waiting to
/// run once the going run finishes, or refused for a token that did not match.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    IntoStaticStr,
    VariantArray,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum WorkflowWebhookFireOutcome {
    /// A run started.
    Started,
    /// Skipped, because a run was still going.
    Skipped,
    /// Waiting to run once the going run finishes.
    Waiting,
    /// Refused for a token that did not match the kept hash.
    TokenMismatch,
}

/// The last call to a workflow's webhook address and what became of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowWebhookLastFire {
    /// When the call came.
    #[garde(dive)]
    pub at: WireInstant,
    /// What became of it.
    pub outcome: WorkflowWebhookFireOutcome,
}

/// Declares an arm of [`WorkflowDefinitionReadResponse`]: the members a definition read carries
/// whatever its webhook token, spelled here once, then the arm's token dates.
macro_rules! workflow_definition_read {
    ($(
        $(#[doc = $doc:literal])+
        pub struct $name:ident { $($token_dates:tt)* }
    )+) => {$(
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The workflow.
            pub id: WorkflowDefinitionId,
            /// Its name.
            pub name: NonEmptyText,
            /// The version read's number.
            pub version_number: SafeInt<1>,
            /// The version read's id, the one a run start takes.
            pub workflow_version_id: WorkflowVersionId,
            /// The hash of that version's hashed body.
            pub content_hash: WorkflowContentHash,
            /// That version's document.
            #[garde(dive)]
            pub document: WorkflowDocument,
            /// The workflow's own level, which every run of it uses and the builder's level pill
            /// reads.
            pub permission_level: PermissionLevel,
            /// The browser the workflow's runs use in the background, which the builder's browser
            /// pill reads; a new workflow reads `settingsDefault`.
            pub background_browser: WorkflowBackgroundBrowser,
            /// When the workflow was made.
            #[garde(dive)]
            pub created_at: WireInstant,
            /// The last call to the workflow's webhook address and what became of it.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WorkflowWebhookLastFire")]
            #[garde(dive)]
            pub webhook_last_fire: Option<WorkflowWebhookLastFire>,
            /// When the workflow was deleted, absent while it is not. A deleted workflow still
            /// reads, so a run filter can name it; the builder opens no deleted workflow.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WireInstant")]
            #[garde(dive)]
            pub deleted_at: Option<WireInstant>,
            $($token_dates)*
        }
    )+};
}

workflow_definition_read! {
    /// A definition read of a workflow that holds a webhook token: when it was made, and when a
    /// call last presented it.
    pub struct WorkflowDefinitionReadWithWebhookToken {
        /// When the webhook token was made.
        #[garde(dive)]
        pub webhook_token_created_at: WireInstant,
        /// When a call last presented the token; absent until one has.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        pub webhook_token_last_used_at: Option<WireInstant>,
    }

    /// A definition read of a workflow that holds no webhook token, so no call to its address is
    /// taken.
    pub struct WorkflowDefinitionReadWithoutWebhookToken {
        /// Never present: there is no token.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub webhook_token_created_at: Option<Never>,
        /// Never present: there is no token.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub webhook_token_last_used_at: Option<Never>,
    }
}

/// The `workflow.definition.read` result, its tags riding the document. The webhook token is never
/// read back, only its hash is kept, so the reply carries the token's dates and the last fire's
/// outcome, a last use only beside the token's creation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum WorkflowDefinitionReadResponse {
    /// The workflow holds a webhook token.
    WithWebhookToken(#[garde(dive)] WorkflowDefinitionReadWithWebhookToken),
    /// The workflow holds none.
    WithoutWebhookToken(#[garde(dive)] WorkflowDefinitionReadWithoutWebhookToken),
}

// workflow.definition.list

/// The longest `workflow.definition.list` cursor accepted; a guard against pathological lengths.
const WORKFLOW_DEFINITION_LIST_CURSOR_MAX_LEN: usize = 256;

branded_text! {
    /// Where the next `workflow.definition.list` page starts, written by the daemon and passed back
    /// unchanged. One the daemon did not write is refused as `workflow.cursorUnresolvable`.
    pub struct WorkflowDefinitionListCursor(1..=WORKFLOW_DEFINITION_LIST_CURSOR_MAX_LEN);
}

/// The `workflow.definition.list` input: one page of every saved workflow on this machine. The
/// `workflow_list` agent tool takes it as its input, so each member's description is text a model
/// reads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionListRequest {
    /// The most workflows on one page.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<1>", description = "The most workflows to return.")]
    pub limit: Option<SafeInt<1>>,
    /// Continue from this cursor.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(
        with = "WorkflowDefinitionListCursor",
        description = "The cursor a previous call returned, to read the next page."
    )]
    pub cursor: Option<WorkflowDefinitionListCursor>,
}

/// A workflow's last run: its status and start.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionLastRun {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
    /// Its status.
    pub status: WorkflowRunStatus,
    /// When it started.
    #[garde(dive)]
    pub started_at: WireInstant,
}

/// A workflow's schedule in words, with its next fire computed in the schedule trigger's own time
/// zone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionSchedule {
    /// The schedule's expression.
    pub expression: NonEmptyText,
    /// The time zone it fires in.
    pub time_zone: NonEmptyText,
    /// The next fire; absent while the workflow is off.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireInstant")]
    #[garde(dive)]
    pub next_fire_at: Option<WireInstant>,
}

/// A fire the trigger's overlap choice skipped because a run was still going, with that run's
/// start; a skipped fire is never a run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowSkippedFire {
    /// The occurrence that was skipped.
    #[garde(dive)]
    pub scheduled_at: WireInstant,
    /// When the run still going had started.
    #[garde(dive)]
    pub running_since: WireInstant,
}

/// One definition in a list, with what a catalog row shows beside the name, so the table needs no
/// second read per row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionSummary {
    /// The workflow.
    pub id: WorkflowDefinitionId,
    /// Its name.
    pub name: NonEmptyText,
    /// The latest version's number, which a version read addresses; passed through beside
    /// `latestWorkflowVersionId`, never derived from it.
    pub latest_version_number: SafeInt<1>,
    /// The latest version's id, which a run start takes.
    pub latest_workflow_version_id: WorkflowVersionId,
    /// The hash of the latest version's hashed body.
    pub content_hash: WorkflowContentHash,
    /// The kind of the document's one trigger.
    pub trigger_kind: WorkflowNodeKindId,
    /// The last run; absent where the workflow never ran, which is no failure.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowDefinitionLastRun")]
    #[garde(dive)]
    pub last_run: Option<WorkflowDefinitionLastRun>,
    /// The schedule; absent where the workflow declares none.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowDefinitionSchedule")]
    #[garde(dive)]
    pub schedule: Option<WorkflowDefinitionSchedule>,
    /// The last fire the trigger's overlap choice skipped.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowSkippedFire")]
    #[garde(dive)]
    pub last_skipped_fire: Option<WorkflowSkippedFire>,
    /// Whether the workflow's triggers are armed: the toggle's own truth, so the row reverts
    /// visibly when the daemon refuses rather than holding an optimistic value.
    pub enabled: bool,
    /// The workflow's tags.
    #[garde(dive)]
    pub tags: TagList,
    /// How many runs it has.
    pub run_count: SafeInt<0>,
    /// When it was made.
    #[garde(dive)]
    pub created_at: WireInstant,
    /// When it last changed.
    #[garde(dive)]
    pub updated_at: WireInstant,
}

/// The `workflow.definition.list` result: one page of definitions, each listed once across pages.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionListResponse {
    /// The page.
    #[garde(dive)]
    pub definitions: Vec<WorkflowDefinitionSummary>,
    /// Where the next page starts; absent on the last.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowDefinitionListCursor")]
    pub next_cursor: Option<WorkflowDefinitionListCursor>,
}

// workflow.definition.update and workflow.definition.delete

/// The `workflow.definition.update` input (Save, Restore, a schedule change): it writes a new
/// version only while `expectedVersionNumber` is the latest, else refuses `workflow.version.stale`,
/// and a document identical to the latest writes none and answers with that version. A Restore
/// names the version it repeats in `restoredVersionNumber`, whose package locks it keeps, and a
/// name another workflow holds, compared ignoring case, is refused with
/// `workflow.definition.refused`, finding `name_taken`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionUpdateRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The version the author loaded, which must still be the latest.
    pub expected_version_number: SafeInt<1>,
    /// The document.
    #[garde(dive)]
    pub document: WorkflowDocument,
    /// On a Restore, the older version the document repeats.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<1>")]
    pub restored_version_number: Option<SafeInt<1>>,
}

/// The `workflow.definition.update` result: the new version of the requested definition, or its
/// latest where the document was identical to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionUpdateResponse {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The version's number.
    pub version_number: SafeInt<1>,
    /// The version's id, the one a run start takes.
    pub workflow_version_id: WorkflowVersionId,
    /// The hash of its hashed body.
    pub content_hash: WorkflowContentHash,
    /// When it was saved.
    #[garde(dive)]
    pub created_at: WireInstant,
}

/// The `workflow.definition.delete` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionDeleteRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
}

/// The `workflow.definition.delete` result. The delete is soft: the runs that pinned the
/// definition's versions stay readable, and the reply counts them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionDeleteResponse {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// Always `true`.
    pub deleted: True,
    /// How many runs stay readable.
    pub retained_run_count: SafeInt<0>,
}

// workflow.definition.export and workflow.definition.import

/// The `workflow.definition.export` input: the daemon writes one version's canonical file, its body
/// and, unless `includeLayout` is false, its layout, with each Code node's package lock. `filePath`
/// is the path main forwards in place of the token the platform's save chooser returned.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionExportRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The version's number; absent for the latest.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<1>")]
    pub version: Option<SafeInt<1>>,
    /// Whether the file carries the layout section; absent, it does.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub include_layout: Option<bool>,
    /// The file to write, the path main's relay put in place of the save chooser's token.
    pub file_path: FilesystemPath,
}

/// The `workflow.definition.export` result: the version written and its content hash.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionExportResponse {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The version's number.
    pub version_number: SafeInt<1>,
    /// The hash of its hashed body.
    pub content_hash: WorkflowContentHash,
}

/// The `workflow.definition.import` input: the daemon reads the picked file at `filePath` (main
/// forwards it in place of the open chooser's token) and creates the definition through the create
/// path, all or nothing. A name another workflow holds, compared ignoring case, is refused with
/// `workflow.definition.refused`, finding `name_taken`, and an unknown schema version with
/// `workflow.definition.importSchemaUnknown`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDefinitionImportRequest {
    /// The file to read.
    pub file_path: FilesystemPath,
}

methods! {
    /// The `workflow.*` methods over definitions: create, read, list, update, delete, export and
    /// import, the version reads, and the settings, draft, expression preview and webhook kept
    /// beside a workflow's versions.
    pub const WORKFLOW_DEFINITION_METHOD_DESCRIPTORS = [
        /// Saves a new workflow as its first version; also Duplicate.
        WorkflowDefinitionCreate = mutation "workflow.definition.create" {
            mutating: true,
            params: WorkflowDefinitionCreateRequest,
            result: WorkflowDefinitionCreateResponse,
            refusals: [WorkflowDefinitionRefused],
        },
        /// Reads one definition at a version, the latest by default.
        WorkflowDefinitionRead = query "workflow.definition.read" {
            mutating: false,
            params: WorkflowDefinitionReadRequest,
            result: WorkflowDefinitionReadResponse,
            refusals: [WorkflowDefinitionNotFound, WorkflowVersionNotFound],
        },
        /// Lists one page of every workflow in the one library.
        WorkflowDefinitionList = query "workflow.definition.list" {
            mutating: false,
            params: WorkflowDefinitionListRequest,
            result: WorkflowDefinitionListResponse,
            refusals: [WorkflowCursorUnresolvable],
        },
        /// Reads one saved version.
        WorkflowVersionRead = query "workflow.version.read" {
            mutating: false,
            params: WorkflowVersionReadRequest,
            result: WorkflowVersionReadResponse,
            refusals: [WorkflowDefinitionNotFound, WorkflowVersionNotFound],
        },
        /// Reads every version of the definition a version id belongs to.
        WorkflowVersionList = query "workflow.version.list" {
            mutating: false,
            params: WorkflowVersionListRequest,
            result: WorkflowVersionListResponse,
            refusals: [WorkflowVersionNotFound],
        },
        /// Saves a new version of a workflow: Save, Restore and a schedule change.
        WorkflowDefinitionUpdate = mutation "workflow.definition.update" {
            mutating: true,
            params: WorkflowDefinitionUpdateRequest,
            result: WorkflowDefinitionUpdateResponse,
            refusals: [WorkflowDefinitionNotFound, WorkflowVersionNotFound, WorkflowVersionStale, WorkflowDefinitionRefused],
        },
        /// Deletes a workflow, softly: its runs stay readable.
        WorkflowDefinitionDelete = mutation "workflow.definition.delete" {
            mutating: true,
            params: WorkflowDefinitionDeleteRequest,
            result: WorkflowDefinitionDeleteResponse,
            refusals: [WorkflowDefinitionNotFound],
        },
        /// Writes one version's canonical file to the file the person picked.
        WorkflowDefinitionExport = mutation "workflow.definition.export" {
            mutating: true,
            params: WorkflowDefinitionExportRequest,
            result: WorkflowDefinitionExportResponse,
            refusals: [WorkflowDefinitionNotFound, WorkflowVersionNotFound],
        },
        /// Reads the file the person picked and saves it through the create path.
        WorkflowDefinitionImport = mutation "workflow.definition.import" {
            mutating: true,
            params: WorkflowDefinitionImportRequest,
            result: WorkflowDefinitionCreateResponse,
            refusals: [WorkflowDefinitionRefused, WorkflowDefinitionImportSchemaUnknown],
        },
        /// Arms or disarms every trigger of one workflow.
        WorkflowEnabledUpdate = mutation "workflow.enabled.update" {
            mutating: true,
            params: WorkflowEnabledUpdateRequest,
            result: WorkflowEnabledUpdateResponse,
            refusals: [WorkflowDefinitionNotFound, WorkflowTriggerUnarmable],
        },
        /// Saves the canvas layout without a new version.
        WorkflowLayoutUpdate = mutation "workflow.layout.update" {
            mutating: true,
            params: WorkflowLayoutUpdateRequest,
            result: WorkflowDefinitionSettingResponse,
            refusals: [WorkflowDefinitionNotFound],
        },
        /// Replaces the workflow's tags without a new version.
        WorkflowTagsUpdate = mutation "workflow.tags.update" {
            mutating: true,
            params: WorkflowTagsUpdateRequest,
            result: WorkflowDefinitionSettingResponse,
            refusals: [WorkflowDefinitionNotFound],
        },
        /// Sets the level every run of the workflow uses, without a new version.
        WorkflowPermissionLevelUpdate = mutation "workflow.permissionLevel.update" {
            mutating: true,
            params: WorkflowPermissionLevelUpdateRequest,
            result: WorkflowPermissionLevelUpdateResponse,
            refusals: [WorkflowDefinitionNotFound],
        },
        /// Sets the background browser every later run of the workflow uses, without a new
        /// version.
        WorkflowBackgroundBrowserUpdate = mutation "workflow.backgroundBrowser.update" {
            mutating: true,
            params: WorkflowBackgroundBrowserUpdateRequest,
            result: WorkflowBackgroundBrowserUpdateResponse,
            refusals: [WorkflowDefinitionNotFound],
        },
        /// Pins or unpins a node's test data without a new version.
        WorkflowPinDataUpdate = mutation "workflow.pinData.update" {
            mutating: true,
            params: WorkflowPinDataUpdateRequest,
            result: WorkflowPinDataUpdateResponse,
            refusals: [WorkflowDefinitionNotFound],
        },
        /// Holds the builder's unsaved draft so it survives a reload.
        WorkflowDraftUpdate = mutation "workflow.draft.update" {
            mutating: true,
            params: WorkflowDraftUpdateRequest,
            result: WorkflowDraftUpdateResponse,
            refusals: [WorkflowDefinitionNotFound],
        },
        /// Reads the held draft back after a reload.
        WorkflowDraftRead = query "workflow.draft.read" {
            mutating: false,
            params: WorkflowDraftReadRequest,
            result: WorkflowDraftReadResponse,
            refusals: [WorkflowDefinitionNotFound],
        },
        /// Evaluates one expression against an item of the last run; never resolves a secret.
        WorkflowExpressionPreview = query "workflow.expression.preview" {
            mutating: false,
            params: WorkflowExpressionPreviewRequest,
            result: WorkflowExpressionPreviewResponse,
            refusals: [WorkflowDefinitionNotFound],
        },
        /// Reads the structural difference between two versions of one workflow.
        WorkflowVersionDiffRead = query "workflow.version.diff.read" {
            mutating: false,
            params: WorkflowVersionDiffReadRequest,
            result: WorkflowVersionDiffReadResponse,
            refusals: [WorkflowVersionNotFound, WorkflowVersionDiffCrossWorkflow],
        },
        /// Creates or replaces the workflow's webhook token, shown once.
        WorkflowWebhookTokenRotate = mutation "workflow.webhookToken.rotate" {
            mutating: true,
            params: WorkflowWebhookTokenRotateRequest,
            result: WorkflowWebhookTokenRotateResponse,
            refusals: [WorkflowDefinitionNotFound],
        },
        /// Reads the webhook listener's port and whether it listens.
        WorkflowWebhookListenerRead = query "workflow.webhookListener.read" {
            mutating: false,
            params: EmptyPayload,
            result: WorkflowWebhookListenerReadResponse,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the definition methods and the definition methods' table.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/definition/methods",
    doc: "The `workflow.*` methods over definitions: create, read, list, update, delete, export \
          and import, and the one method table for every definition method.",
    definitions: &[
        Definition::read::<WorkflowDefinitionCreateRequest>().checked(),
        Definition::read::<WorkflowDefinitionCreateResponse>().checked(),
        Definition::read::<WorkflowDefinitionReadRequest>().checked(),
        Definition::read::<WorkflowWebhookFireOutcome>(),
        Definition::read::<WorkflowWebhookLastFire>(),
        Definition::read::<WorkflowDefinitionReadWithWebhookToken>(),
        Definition::read::<WorkflowDefinitionReadWithoutWebhookToken>(),
        Definition::read::<WorkflowDefinitionReadResponse>().checked(),
        Definition::read::<WorkflowDefinitionListCursor>(),
        Definition::read::<WorkflowDefinitionListRequest>().checked(),
        Definition::read::<WorkflowDefinitionLastRun>(),
        Definition::read::<WorkflowDefinitionSchedule>(),
        Definition::read::<WorkflowSkippedFire>(),
        Definition::read::<WorkflowDefinitionSummary>().checked(),
        Definition::read::<WorkflowDefinitionListResponse>().checked(),
        Definition::read::<WorkflowDefinitionUpdateRequest>().checked(),
        Definition::read::<WorkflowDefinitionUpdateResponse>().checked(),
        Definition::read::<WorkflowDefinitionDeleteRequest>().checked(),
        Definition::read::<WorkflowDefinitionDeleteResponse>().checked(),
        Definition::read::<WorkflowDefinitionExportRequest>().checked(),
        Definition::read::<WorkflowDefinitionExportResponse>().checked(),
        Definition::read::<WorkflowDefinitionImportRequest>().checked(),
    ],
    constants: &[],
    method_tables: &[&WORKFLOW_DEFINITION_METHOD_DESCRIPTORS],
};
