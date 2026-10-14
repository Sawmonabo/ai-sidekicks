//! The state kept beside a workflow's versions, which saves no new version: the enabled switch, the
//! canvas layout, the tags, the permission level, the background-browser pick, pinned test data,
//! the builder's unsaved draft, the expression preview, and the webhook token and listener. The
//! definition methods' table lists these methods.

use std::borrow::Cow;
use std::fmt;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};

use crate::session::controls::methods::PermissionLevel;
use crate::tag::TagList;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::{Port, SafeInt};
use crate::wire::text::NonEmptyText;
use crate::wire::{AnyValue, False, Never, True};
use crate::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowDraftDocument, WorkflowLayout, WorkflowNodeId,
};
use crate::workflow::definition::item::WorkflowPinnedItem;

ts_constants! {
    /// Wire members a reply-logging transport redacts before writing a record: the webhook token a
    /// rotation shows once.
    pub const WORKFLOW_WEBHOOK_TOKEN_REDACTED_WIRE_MEMBERS: [&str; 1] = ["token"];
}

// Settings kept beside a version: enabled, layout, tags, permission level, background browser,
// pinned data.

/// The `workflow.enabledSet` input: arm or disarm every trigger of one workflow. A trigger that
/// cannot be armed refuses the switch with `workflow.trigger_unarmable`, and nothing turns on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowEnabledSetRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// Whether its triggers are armed.
    pub enabled: bool,
}

/// The `workflow.enabledSet` result: the switch's state and how many triggers are armed now, none
/// on a disarm; on an arm it is every trigger the workflow declares, since a partial arm refuses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|response: &Self, (): &()| {
    if response.enabled || response.armed_trigger_count.get() == 0 {
        Ok(())
    } else {
        Err(garde::Error::new("a disarmed workflow has no armed trigger"))
    }
}))]
#[schemars(extend(
    "if" = { "properties": { "enabled": { "const": false } } },
    "then" = { "properties": { "armedTriggerCount": { "const": 0 } } },
))]
pub struct WorkflowEnabledSetResponse {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// Whether its triggers are armed.
    pub enabled: bool,
    /// How many triggers are armed now; 0 when `enabled` is false.
    pub armed_trigger_count: SafeInt<0>,
}

/// The `workflow.layoutSet` input: the whole canvas layout, saved on the definition without a new
/// version. Saved versions keep the layout they were written with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowLayoutSetRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The layout.
    pub layout: WorkflowLayout,
}

/// When a setting kept beside the definition was stored; `workflow.layoutSet` and
/// `workflow.tagsSet` answer with it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDefinitionSettingResponse {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// When the setting was stored.
    pub updated_at: WireInstant,
}

/// The `workflow.tagsSet` input: the workflow's whole tag set, which replaces the one held, so a
/// remove and an add are one write. Tags sit outside the hashed body, so a change mints no version;
/// a tag that breaks the tag rule, or a repeat ignoring case, fails the parse.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowTagsSetRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The whole tag set.
    #[garde(dive)]
    pub tags: TagList,
}

/// The `workflow.permissionLevelUpdate` input: the level every run of the workflow uses, a live run
/// from its next step. A new workflow starts at `yolo`; the level sits outside the hashed body, so
/// a change mints no version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowPermissionLevelUpdateRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The level.
    pub level: PermissionLevel,
}

/// The level the workflow now runs at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowPermissionLevelUpdateResponse {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The level.
    pub level: PermissionLevel,
}

/// The browser a workflow's runs use in the background, picked on the builder's browser pill: the
/// machine setting's choice, or sandboxed or not whatever that setting says. A new workflow reads
/// `settings_default`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowBackgroundBrowser {
    /// Whatever the machine's setting picks.
    #[default]
    SettingsDefault,
    /// Sandboxed.
    Sandboxed,
    /// Not sandboxed.
    NotSandboxed,
}

/// The `workflow.backgroundBrowserUpdate` input: the background-browser pick every later run of the
/// workflow uses, a live run keeping the browser it started with. The pick sits outside the hashed
/// body, so a change mints no version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowBackgroundBrowserUpdateRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The pick.
    pub pick: WorkflowBackgroundBrowser,
}

/// The background-browser pick the workflow's runs now use.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowBackgroundBrowserUpdateResponse {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The pick.
    pub pick: WorkflowBackgroundBrowser,
}

/// The `workflow.pinDataSet` input: pin items onto one node as test data, or unpin with `null`,
/// without a new version. Pinned data is honored only in manual runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowPinDataSetRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The node.
    pub node_id: WorkflowNodeId,
    /// The items to pin, or `null` to unpin.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<Vec<WorkflowPinnedItem>>")]
    #[garde(dive)]
    pub items: Option<Vec<WorkflowPinnedItem>>,
}

/// The `workflow.pinDataSet` result: whether the node is pinned now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowPinDataSetResponse {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The node.
    pub node_id: WorkflowNodeId,
    /// Whether it is pinned.
    pub pinned: bool,
}

// The builder's draft

/// Declares the draft of a saved workflow and the draft of a new one, with the members every draft
/// carries spelled once. A saved workflow's draft names it and the version it was opened from; a
/// new workflow's names neither, so a version number never appears without the definition.
macro_rules! workflow_draft_arms {
    (
        $(#[doc = $saved_doc:literal])+
        pub struct $saved:ident;
        $(#[doc = $new_doc:literal])+
        pub struct $new:ident;
        { $($members:tt)* }
    ) => {
        $(#[doc = $saved_doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        pub struct $saved {
            /// The saved workflow.
            pub definition_id: WorkflowDefinitionId,
            /// The version the builder opened.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "SafeInt<1>")]
            pub based_on_version_number: Option<SafeInt<1>>,
            /// The whole unsaved document.
            #[garde(dive)]
            pub document: WorkflowDraftDocument,
            $($members)*
        }

        $(#[doc = $new_doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        pub struct $new {
            /// Never present: a new workflow has no definition yet.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            pub definition_id: Option<Never>,
            /// Never present: a new workflow has no version.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            pub based_on_version_number: Option<Never>,
            /// The whole unsaved document.
            #[garde(dive)]
            pub document: WorkflowDraftDocument,
            $($members)*
        }
    };
}

workflow_draft_arms! {
    /// A saved workflow's draft as `workflow.draftUpdate` sends it.
    pub struct SavedWorkflowDraftUpdateRequest;
    /// The new workflow's draft as `workflow.draftUpdate` sends it.
    pub struct NewWorkflowDraftUpdateRequest;
    {}
}

workflow_draft_arms! {
    /// A saved workflow's held draft: what the last update sent, and when it was stored.
    pub struct SavedWorkflowDraft;
    /// The new workflow's held draft: what the last update sent, and when it was stored.
    pub struct NewWorkflowDraft;
    {
        /// When the daemon stored it.
        #[garde(dive)]
        pub updated_at: WireInstant,
    }
}

/// The `workflow.draftUpdate` input: the builder's whole unsaved document, which replaces the one
/// held. The daemon holds one draft per saved workflow, named by `definitionId` with the version it
/// was opened from, and one for a new workflow, which omits both; saving the version clears it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum WorkflowDraftUpdateRequest {
    /// A saved workflow's draft.
    Saved(#[garde(dive)] SavedWorkflowDraftUpdateRequest),
    /// The new workflow's draft.
    New(#[garde(dive)] NewWorkflowDraftUpdateRequest),
}

/// When the daemon stored the draft.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDraftUpdateResponse {
    /// When it was stored.
    pub updated_at: WireInstant,
}

/// The `workflow.draftRead` input: the draft of the workflow the builder's address names, or, with
/// no `definitionId`, the new workflow's draft. A reload reads it back this way.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowDraftReadRequest {
    /// The saved workflow; absent for the new workflow's draft.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowDefinitionId")]
    pub definition_id: Option<WorkflowDefinitionId>,
}

/// One held draft: what the last update sent, and when it was stored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum WorkflowDraft {
    /// A saved workflow's draft.
    Saved(#[garde(dive)] SavedWorkflowDraft),
    /// The new workflow's draft.
    New(#[garde(dive)] NewWorkflowDraft),
}

/// The `workflow.draftRead` result. A draft that is no longer held is an answer, `null`, not an
/// error.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDraftReadResponse {
    /// The held draft, or `null`.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<WorkflowDraft>")]
    pub draft: Option<WorkflowDraft>,
}

// workflow.expressionPreview

/// The `workflow.expressionPreview` input: one expression of one node, evaluated in the daemon
/// against an item of the last run. The node is read from the workflow's held draft, else its
/// latest saved version; with no `definitionId`, from the new workflow's draft. It never resolves a
/// secret: a sensitive field previews the secret's name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowExpressionPreviewRequest {
    /// The workflow the expression sits in; absent for a new workflow.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowDefinitionId")]
    pub definition_id: Option<WorkflowDefinitionId>,
    /// The node.
    pub node_id: WorkflowNodeId,
    /// The expression.
    pub expression: NonEmptyText,
    /// The zero-based index of the item the inspector's data panels show.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub item_index: Option<SafeInt<0>>,
}

/// An expression that resolved against the item: its value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowExpressionResolved {
    /// Always `true`.
    pub ok: True,
    /// The value.
    pub value: AnyValue,
    /// Never present: a resolved expression has no failure.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub reason: Option<Never>,
}

/// An expression that does not resolve against the item: why, in words the field shows in place
/// of a value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowExpressionUnresolved {
    /// Always `false`.
    pub ok: False,
    /// Never present: an unresolved expression has no value.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub value: Option<Never>,
    /// Why it does not resolve.
    pub reason: NonEmptyText,
}

/// The `workflow.expressionPreview` result: the value, or why the expression does not resolve
/// against that item.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum WorkflowExpressionPreviewResponse {
    /// The value.
    Resolved(WorkflowExpressionResolved),
    /// Why there is none.
    Unresolved(WorkflowExpressionUnresolved),
}

// The webhook token and the listener

/// The `workflow.webhookTokenRotate` input: create the workflow's webhook token, or replace it. The
/// old token is refused from that moment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowWebhookTokenRotateRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
}

/// A workflow's webhook token, shown once in its rotation's reply and never logged: only its hash
/// is kept. Its `Debug` form leaves it out.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WorkflowWebhookToken(NonEmptyText);

impl WorkflowWebhookToken {
    /// `token` when it holds at least one code point, else `None`.
    pub fn new(token: String) -> Option<Self> {
        NonEmptyText::new(token).map(Self)
    }
}

impl fmt::Debug for WorkflowWebhookToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

impl JsonSchema for WorkflowWebhookToken {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "WorkflowWebhookToken".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        NonEmptyText::json_schema(generator)
    }
}

/// The `workflow.webhookTokenRotate` result: the new token, shown once. Only its hash is kept, so
/// no later read returns it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowWebhookTokenRotateResponse {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// The token.
    pub token: WorkflowWebhookToken,
    /// When it was made.
    pub created_at: WireInstant,
}

/// Whether the webhook listener listens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowWebhookListenerState {
    /// It listens on its port.
    Listening,
    /// Another program held the port when the daemon started, so it does not listen and no
    /// workflow has an address.
    PortTaken,
}

/// The `workflow.webhookListenerRead` result: the one loopback port the listener binds, and
/// whether it listens.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowWebhookListenerReadResponse {
    /// The port.
    pub port: Port,
    /// Whether it listens.
    pub state: WorkflowWebhookListenerState,
}

/// The TypeScript module of the state kept beside a workflow's versions.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/definition/builder",
    doc: "The state kept beside a workflow's versions, which saves no new version: the enabled \
          switch, the canvas layout, the tags, the permission level, the background-browser pick, \
          pinned test data, the builder's unsaved draft, the expression preview, and the webhook \
          token and listener.",
    definitions: &[
        Definition::read::<WorkflowEnabledSetRequest>().checked(),
        Definition::read::<WorkflowEnabledSetResponse>().checked(),
        Definition::read::<WorkflowLayoutSetRequest>().checked(),
        Definition::read::<WorkflowDefinitionSettingResponse>().checked(),
        Definition::read::<WorkflowTagsSetRequest>().checked(),
        Definition::read::<WorkflowPermissionLevelUpdateRequest>().checked(),
        Definition::read::<WorkflowPermissionLevelUpdateResponse>().checked(),
        Definition::read::<WorkflowBackgroundBrowser>(),
        Definition::read::<WorkflowBackgroundBrowserUpdateRequest>().checked(),
        Definition::read::<WorkflowBackgroundBrowserUpdateResponse>().checked(),
        Definition::read::<WorkflowPinDataSetRequest>().checked(),
        Definition::read::<WorkflowPinDataSetResponse>().checked(),
        Definition::read::<SavedWorkflowDraftUpdateRequest>(),
        Definition::read::<NewWorkflowDraftUpdateRequest>(),
        Definition::read::<WorkflowDraftUpdateRequest>().checked(),
        Definition::read::<WorkflowDraftUpdateResponse>().checked(),
        Definition::read::<WorkflowDraftReadRequest>().checked(),
        Definition::read::<SavedWorkflowDraft>(),
        Definition::read::<NewWorkflowDraft>(),
        Definition::read::<WorkflowDraft>(),
        Definition::read::<WorkflowDraftReadResponse>().checked(),
        Definition::read::<WorkflowExpressionPreviewRequest>().checked(),
        Definition::read::<WorkflowExpressionResolved>(),
        Definition::read::<WorkflowExpressionUnresolved>(),
        Definition::read::<WorkflowExpressionPreviewResponse>().checked(),
        Definition::read::<WorkflowWebhookTokenRotateRequest>().checked(),
        Definition::read::<WorkflowWebhookTokenRotateResponse>().checked(),
        Definition::read::<WorkflowWebhookListenerState>(),
        Definition::read::<WorkflowWebhookListenerReadResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
