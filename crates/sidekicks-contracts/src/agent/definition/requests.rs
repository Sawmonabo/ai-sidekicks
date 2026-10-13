//! The definition verbs' requests and replies: list, create, update, delete, export and import.
//! A write treats an absent member as "leave it to the default" and an explicit `null` as "stop
//! pinning this", while the stored row has no absence, so a write and the row are two shapes.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::binding::AgentDefinitionBindingsDraft;
use super::{
    AgentAccentHue, AgentDefinitionId, AgentDefinitionListEntry, AgentDefinitionScope, AgentHooks,
    AgentMemoryScope, ToolName, add_project_scope_rule, project_matches_scope,
};
use crate::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use crate::project::ProjectId;
use crate::wire::True;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::record::Record;
use crate::wire::text::{FreeFormText, NonEmptyText};

/// The whole registry and two readings folded per reply and never stored. Each reading is absent
/// as a whole only when its source could not be read, so a card leaves its line out rather than
/// showing zero; a definition never run has no `lastUsedAt` key.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentDefinitionListResponse {
    /// The definitions.
    #[garde(dive)]
    pub definitions: Vec<AgentDefinitionListEntry>,
    /// How many workflow definitions bind each definition.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Record<AgentDefinitionId, SafeInt<0>>")]
    pub workflow_usage: Option<Record<AgentDefinitionId, SafeInt<0>>>,
    /// When a session run or a workflow run last resolved each definition.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Record<AgentDefinitionId, WireInstant>")]
    #[garde(dive)]
    pub last_used_at: Option<Record<AgentDefinitionId, WireInstant>>,
}

/// Declares a definition write: the caller's leading members, then the writable members create
/// and update share, each optional and the nullable ones clearable with `null`.
macro_rules! definition_write {
    (
        $(#[$meta:meta])*
        pub struct $name:ident { $($leading:tt)* }
    ) => {
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        $(#[$meta])*
        pub struct $name {
            $($leading)*
            /// The description.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "String")]
            pub description: Option<String>,
            /// A glyph key, or `null` for the generic agent mark.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "serde_with::rust::double_option"
            )]
            #[schemars(with = "crate::wire::NullableSchema<NonEmptyText>")]
            pub icon: Option<Option<NonEmptyText>>,
            /// A hue, or `null` for none.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "serde_with::rust::double_option"
            )]
            #[schemars(with = "crate::wire::NullableSchema<AgentAccentHue>")]
            pub accent_hue: Option<Option<AgentAccentHue>>,
            /// The instructions.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "String")]
            pub instructions: Option<String>,
            /// The goal, or `null` for none.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "serde_with::rust::double_option"
            )]
            #[schemars(with = "crate::wire::NullableSchema<String>")]
            pub goal: Option<Option<String>>,
            /// The tools, or `null` for the driver's defaults.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "serde_with::rust::double_option"
            )]
            #[schemars(with = "crate::wire::NullableSchema<Vec<ToolName>>")]
            pub tool_allowlist: Option<Option<Vec<ToolName>>>,
            /// The turn cap, or `null` for none.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "serde_with::rust::double_option"
            )]
            #[schemars(with = "crate::wire::NullableSchema<SafeInt<1>>")]
            pub turn_cap: Option<Option<SafeInt<1>>>,
            /// The hooks, replacing the stored ones whole, or `null` for none.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "serde_with::rust::double_option"
            )]
            #[schemars(with = "crate::wire::NullableSchema<AgentHooks>")]
            pub hooks: Option<Option<AgentHooks>>,
            /// Where its memory lives, or `null` for no memory.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "serde_with::rust::double_option"
            )]
            #[schemars(with = "crate::wire::NullableSchema<AgentMemoryScope>")]
            pub memory_scope: Option<Option<AgentMemoryScope>>,
        }
    };
}

definition_write! {
    /// A new definition. An omitted member is stored as its null state, so a definition never
    /// silently pins today's default; `scope` defaults to `global`, and a project scope names its
    /// project.
    #[garde(custom(create_names_its_project))]
    #[schemars(transform = add_project_scope_rule)]
    pub struct AgentDefinitionCreateRequest {
        /// The name.
        pub name: ToolName,
        /// The bindings.
        #[garde(dive)]
        pub bindings: AgentDefinitionBindingsDraft,
        /// Every project or one; absent is every project.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "AgentDefinitionScope")]
        pub scope: Option<AgentDefinitionScope>,
        /// The project, exactly when `scope` is `project`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProjectId")]
        pub project_id: Option<ProjectId>,
    }
}

/// Whether a create names its project exactly when its scope is a project.
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "garde passes a check's context by reference"
)]
fn create_names_its_project(request: &AgentDefinitionCreateRequest, (): &()) -> garde::Result {
    project_matches_scope(request.scope, request.project_id.as_ref())
}

/// The created definition, as the list serves it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentDefinitionCreateResponse {
    /// The definition.
    #[garde(dive)]
    pub definition: AgentDefinitionListEntry,
}

definition_write! {
    /// A partial patch: an absent member is unchanged and `null` clears to the inherit state;
    /// `bindings` and `hooks` replace the stored value whole. `reattachFilePath` reattaches an
    /// orphaned record to a provider's file, the path main's relay put in place of the chooser's
    /// token.
    pub struct AgentDefinitionUpdateRequest {
        /// The definition.
        pub definition_id: AgentDefinitionId,
        /// The name.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ToolName")]
        pub name: Option<ToolName>,
        /// The bindings, replacing the stored ones whole.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "AgentDefinitionBindingsDraft")]
        #[garde(dive)]
        pub bindings: Option<AgentDefinitionBindingsDraft>,
        /// The provider's file an orphaned record is reattached to.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FilesystemPath")]
        pub reattach_file_path: Option<FilesystemPath>,
    }
}

/// The whole row after the update, so a client never merges its own patch.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentDefinitionUpdateResponse {
    /// The definition.
    #[garde(dive)]
    pub definition: AgentDefinitionListEntry,
}

/// Deletes a definition: never refused and never cascading. On a provider's own agent the daemon
/// deletes that file and the record beside it in one act; on an orphaned record it discards the
/// record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentDefinitionDeleteRequest {
    /// The definition.
    pub definition_id: AgentDefinitionId,
}

/// A delete's answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentDefinitionDeleteResponse {
    /// Always `true`.
    pub deleted: True,
}

/// Writes the chosen definitions into the folder the person picked, one Markdown file each, every
/// binding with its account left out. An unknown id refuses the whole export.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentDefinitionExportRequest {
    /// The definitions, at least one.
    pub definition_ids: BoundedVec<AgentDefinitionId, 1, { usize::MAX }>,
    /// The folder, the path main's relay put in place of the chooser's token.
    pub folder: FilesystemPath,
}

/// How many definition files the export wrote.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentDefinitionExportResponse {
    /// The count.
    pub exported_count: SafeInt<1>,
}

/// Reads the folder the person picked and creates every agent definition in it in one
/// transaction: it only creates, suffixes a colliding name, lands each in the global scope with
/// no account, and lists every other file it skipped.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentDefinitionImportRequest {
    /// The folder, the path main's relay put in place of the chooser's token.
    pub folder: FilesystemPath,
}

/// Why an import skipped a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
pub enum SkippedImportFileReason {
    /// The file is not an agent definition.
    NotAnAgentDefinition,
}

/// A file an import skipped.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkippedImportFile {
    /// The file's name.
    pub file_name: FreeFormText<FILE_PATH_MAX_LEN>,
    /// Why it was skipped.
    pub reason: SkippedImportFileReason,
}

/// The created rows under their final names, and each skipped file, listed once.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentDefinitionImportResponse {
    /// The created definitions.
    #[garde(dive)]
    pub definitions: Vec<AgentDefinitionListEntry>,
    /// The skipped files.
    pub skipped: Vec<SkippedImportFile>,
}
