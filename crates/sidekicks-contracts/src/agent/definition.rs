//! Saved agents: the definition registry a person builds in the library and the editor, the
//! binding that says which provider runs an agent, and the requests and refusals of the
//! definition verbs. A definition is this machine's configuration, never session history, so no
//! verb here appends an event. `AgentId` lives here beside the definition's id because every
//! other agent module imports it.

use std::fmt;

use schemars::{JsonSchema, Schema};
use serde::{Deserialize, Serialize};
use serde_json::json;
use strum::VariantArray;

use crate::free_form_string::FilesystemPath;
use crate::internal::branded::branded_uuid_id;
use crate::jsonrpc::refusal::RefusalCode;
use crate::project::ProjectId;
use crate::provider::driver::length_limits::DRIVER_TOOL_NAME_MAX_LEN;
use crate::schema::{push_all_of, required_member};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::inline_scalar_definition;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::record::{JsonRecord, Record};
use crate::wire::text::{FreeFormText, NonEmptyText};

pub mod binding;
pub mod refusal;
pub mod requests;

use binding::{AgentDefinitionBindings, AgentListedBindings, AgentProviderBinding};

ts_constants! {
    /// The longest reason text a refusal or a load failure carries.
    pub const AGENT_REASON_MAX_LEN: usize = 1024;
    /// A definition that exists but cannot produce a runnable agent now.
    AGENT_RESOLUTION_REFUSED_CODE = RefusalCode::AgentResolutionRefused;
    /// The agent hue wheel's twelve steps by token name, in wheel order.
    AGENT_ACCENT_HUES = AgentAccentHue::VARIANTS;
}

branded_uuid_id! {
    /// A saved definition's daemon-minted id, never its name, so a rename orphans no stored
    /// reference.
    AgentDefinitionId
}

/// A definition id names a member of a record keyed by definition.
impl AsRef<str> for AgentDefinitionId {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

/// A definition id as a check's report names the member it keys.
impl fmt::Display for AgentDefinitionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A record keyed by definition reports a failed value under its id.
impl garde::error::PathComponentKind for AgentDefinitionId {
    fn component_kind() -> garde::error::Kind {
        garde::error::Kind::Key
    }
}

branded_uuid_id! {
    /// A live agent's daemon-minted id: the lead of a session, or an agent it reached.
    AgentId
}

/// A tool name on an allowlist, as the catalog spells it.
pub type ToolName = FreeFormText<DRIVER_TOOL_NAME_MAX_LEN>;

/// Where an agent's one memory lives: `user` in the daemon's own agent-memory folder, for every
/// project; `project` in the project's repository; `local` in the project but kept out of the
/// repository. Either provider running the agent reads and writes the same folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentMemoryScope {
    /// Every project.
    User,
    /// In the project's repository.
    Project,
    /// In the project, kept out of the repository.
    Local,
}

/// One step of the agent hue wheel.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
pub enum AgentAccentHue {
    /// Step 0.
    #[serde(rename = "hue-00")]
    Hue00,
    /// Step 1.
    #[serde(rename = "hue-01")]
    Hue01,
    /// Step 2.
    #[serde(rename = "hue-02")]
    Hue02,
    /// Step 3.
    #[serde(rename = "hue-03")]
    Hue03,
    /// Step 4.
    #[serde(rename = "hue-04")]
    Hue04,
    /// Step 5.
    #[serde(rename = "hue-05")]
    Hue05,
    /// Step 6.
    #[serde(rename = "hue-06")]
    Hue06,
    /// Step 7.
    #[serde(rename = "hue-07")]
    Hue07,
    /// Step 8.
    #[serde(rename = "hue-08")]
    Hue08,
    /// Step 9.
    #[serde(rename = "hue-09")]
    Hue09,
    /// Step 10.
    #[serde(rename = "hue-10")]
    Hue10,
    /// Step 11.
    #[serde(rename = "hue-11")]
    Hue11,
}

/// One matcher's handlers under a hook event, in Claude Code's own shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentHookGroup {
    /// Which calls the handlers run on; absent runs them on every call.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub matcher: Option<String>,
    /// The handlers, each as the provider's hook schema spells it; the daemon checks each when it
    /// saves.
    pub hooks: BoundedVec<JsonRecord, 1, { usize::MAX }>,
}

/// An agent's own hooks in Claude Code's shape, the form an agent file's `hooks` key holds: per
/// event name, the matcher groups.
pub type AgentHooks = Record<ToolName, Vec<AgentHookGroup>>;

/// Whether a definition belongs to every project or to one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentDefinitionScope {
    /// Every project.
    Global,
    /// One project.
    Project,
}

/// Which files a definition came from: ours, a provider's own, or a plugin's, which is read-only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AgentDefinitionOrigin {
    /// Ours, under `.ai-sidekicks/agents/`.
    Ours,
    /// Claude Code's agent files.
    Claude,
    /// Codex's agent files.
    Codex,
    /// A plugin's.
    Plugin,
}

/// Whether a scope and a project agree: a project scope names its project and no other does; an
/// absent scope is global. Saved agents and skills share the rule.
pub fn project_matches_scope(
    scope: Option<AgentDefinitionScope>,
    project_id: Option<&ProjectId>,
) -> garde::Result {
    if (scope == Some(AgentDefinitionScope::Project)) == project_id.is_some() {
        Ok(())
    } else {
        Err(garde::Error::new(
            "projectId is present exactly when scope is project",
        ))
    }
}

/// Whether an origin and a plugin name agree: a plugin's entry names its plugin and no other
/// does. Saved agents and skills share the rule.
pub fn plugin_name_matches_origin<T>(
    origin: AgentDefinitionOrigin,
    plugin_name: Option<&T>,
) -> garde::Result {
    if (origin == AgentDefinitionOrigin::Plugin) == plugin_name.is_some() {
        Ok(())
    } else {
        Err(garde::Error::new(
            "pluginName is present exactly when origin is plugin",
        ))
    }
}

/// Whether a listed entry names its plugin and its project exactly where its origin and scope
/// say. Listed agents and skills share the rule.
pub fn entry_names_its_plugin_and_project<T>(
    origin: AgentDefinitionOrigin,
    plugin_name: Option<&T>,
    scope: AgentDefinitionScope,
    project_id: Option<&ProjectId>,
) -> garde::Result {
    plugin_name_matches_origin(origin, plugin_name)?;
    project_matches_scope(Some(scope), project_id)
}

/// Appends to `schema`'s `allOf` the rule that `member` is present exactly when `discriminant`
/// is `value`.
pub(crate) fn add_present_exactly_when(
    schema: &mut Schema,
    discriminant: &str,
    value: &str,
    member: &str,
) {
    push_all_of(
        schema,
        json!({
            "if": {
                "type": "object",
                "properties": { discriminant: { "const": value } },
                "required": [discriminant],
            },
            "then": required_member(member),
            "else": { "not": required_member(member) },
        }),
    );
}

/// The schema twin of [`project_matches_scope`], for a schema's `transform`.
pub(crate) fn add_project_scope_rule(schema: &mut Schema) {
    add_present_exactly_when(schema, "scope", "project", "projectId");
}

/// The schema twin of [`plugin_name_matches_origin`], for a schema's `transform`.
pub(crate) fn add_plugin_origin_rule(schema: &mut Schema) {
    add_present_exactly_when(schema, "origin", "plugin", "pluginName");
}

/// Declares a definition record: the members every stored definition carries, its bindings, and
/// the members the caller adds.
macro_rules! definition_record {
    (
        $(#[$meta:meta])*
        pub struct $name:ident { bindings: $bindings:ty, $($extra:tt)* }
    ) => {
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        $(#[$meta])*
        pub struct $name {
            /// The definition's id.
            pub definition_id: AgentDefinitionId,
            /// The name.
            pub name: ToolName,
            /// The description.
            pub description: String,
            /// A glyph key from the app's icon set; `null` is the generic agent mark.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<NonEmptyText>")]
            pub icon: Option<NonEmptyText>,
            /// One step of the hue wheel; `null` is no chosen hue.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<AgentAccentHue>")]
            pub accent_hue: Option<AgentAccentHue>,
            /// The bindings.
            #[garde(dive)]
            pub bindings: $bindings,
            /// The instructions.
            pub instructions: String,
            /// The goal, or `null` for none.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<String>")]
            pub goal: Option<String>,
            /// `null` is the driver's defaults, `[]` no tools, and a list exactly those, so "I did
            /// not choose" never reads as "I chose nothing".
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<Vec<ToolName>>")]
            pub tool_allowlist: Option<Vec<ToolName>>,
            /// The turns before the agent is stopped, or `null` for no cap.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<SafeInt<1>>")]
            pub turn_cap: Option<SafeInt<1>>,
            /// The agent's own hooks, or `null` for none.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<AgentHooks>")]
            pub hooks: Option<AgentHooks>,
            /// Where its memory lives, or `null` for no memory.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<AgentMemoryScope>")]
            pub memory_scope: Option<AgentMemoryScope>,
            /// When it was created.
            #[garde(dive)]
            pub created_at: WireInstant,
            /// When it last changed.
            #[garde(dive)]
            pub updated_at: WireInstant,
            $($extra)*
        }
    };
}

definition_record! {
    /// One saved definition, as our own agent files hold it.
    pub struct AgentDefinition { bindings: AgentDefinitionBindings, }
}

definition_record! {
    /// One definition as the list serves it: the record, where it lives, and its provider facts,
    /// none excluding another, since an orphaned record can also carry a load error.
    #[garde(custom(|entry: &Self, (): &()| entry_names_its_plugin_and_project(
        entry.origin,
        entry.plugin_name.as_ref(),
        entry.scope,
        entry.project_id.as_ref(),
    )))]
    #[schemars(transform = add_plugin_origin_rule)]
    #[schemars(transform = add_project_scope_rule)]
    pub struct AgentDefinitionListEntry {
        bindings: AgentListedBindings,
        /// Which files it came from.
        pub origin: AgentDefinitionOrigin,
        /// The plugin, exactly on a plugin's agent.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ToolName")]
        pub plugin_name: Option<ToolName>,
        /// Every project or one.
        pub scope: AgentDefinitionScope,
        /// The project, exactly when `scope` is `project`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProjectId")]
        pub project_id: Option<ProjectId>,
        /// The record's file, or for an orphaned record the last path it was known at; shown,
        /// never a capability.
        pub source_path: FilesystemPath,
        /// A provider's file was renamed or deleted outside the app; the record keeps its extras
        /// until it is reattached or discarded.
        pub orphaned: bool,
        /// The provider's own configuration switches the agent off.
        pub disabled_in_provider: bool,
        /// Why the file failed the daemon's own parse.
        #[serde(deserialize_with = "crate::wire::nullable")]
        #[schemars(with = "crate::wire::NullableSchema<FreeFormText<AGENT_REASON_MAX_LEN>>")]
        pub load_error: Option<FreeFormText<AGENT_REASON_MAX_LEN>>,
    }
}

/// What a running agent was started with, echoed on whichever reply started it: a record of the
/// start with the resolved binding, never a live view of the definition, which may have moved.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentResolvedConfiguration {
    /// The definition the agent came from.
    pub resolved_from_definition_id: AgentDefinitionId,
    /// The binding it resolved to.
    pub resolved_binding: AgentProviderBinding,
    /// The definition's chosen hue, which the agent wears for the session's life.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<AgentAccentHue>")]
    pub accent_hue: Option<AgentAccentHue>,
    /// The tool allowlist as applied.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<Vec<ToolName>>")]
    pub tool_allowlist: Option<Vec<ToolName>>,
    /// The instructions as applied.
    pub instructions: String,
    /// The goal as applied.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<String>")]
    pub goal: Option<String>,
}

/// The TypeScript module of saved agents.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "agent/definition",
    doc: "Saved agents: the definition registry, the binding that says which provider runs an \
          agent, and the requests and refusals of the definition verbs.",
    definitions: &[
        Definition::read::<AgentDefinitionId>().checked(),
        Definition::read::<AgentId>().checked(),
        Definition::read::<binding::AgentProviderBinding>().checked(),
        Definition::read::<binding::AgentDefinitionBindings>(),
        Definition::read::<binding::AgentDefinitionBindingsDraft>().checked(),
        Definition::read::<binding::AgentListedProviderBinding>().checked(),
        Definition::read::<binding::AgentListedBindings>(),
        Definition::read::<AgentMemoryScope>().checked(),
        Definition::read::<AgentAccentHue>(),
        Definition::read::<AgentHookGroup>(),
        inline_scalar_definition!(
            AgentHooks,
            "AgentHooks",
            "An agent's own hooks in Claude Code's shape: per event name, the matcher groups."
        ),
        Definition::read::<AgentDefinitionScope>(),
        Definition::read::<AgentDefinitionOrigin>(),
        Definition::read::<AgentDefinition>(),
        Definition::read::<AgentDefinitionListEntry>().checked(),
        Definition::read::<AgentResolvedConfiguration>().checked(),
        Definition::read::<requests::AgentDefinitionListResponse>().checked(),
        Definition::read::<requests::AgentDefinitionCreateRequest>().checked(),
        Definition::read::<requests::AgentDefinitionCreateResponse>().checked(),
        Definition::read::<requests::AgentDefinitionUpdateRequest>().checked(),
        Definition::read::<requests::AgentDefinitionUpdateResponse>().checked(),
        Definition::read::<requests::AgentDefinitionDeleteRequest>().checked(),
        Definition::read::<requests::AgentDefinitionDeleteResponse>().checked(),
        Definition::read::<requests::AgentDefinitionExportRequest>().checked(),
        Definition::read::<requests::AgentDefinitionExportResponse>().checked(),
        Definition::read::<requests::AgentDefinitionImportRequest>().checked(),
        Definition::read::<requests::SkippedImportFile>(),
        Definition::read::<requests::AgentDefinitionImportResponse>().checked(),
        Definition::read::<refusal::AgentResolutionRefusedCode>(),
        Definition::read::<refusal::AgentExportWriteFailedDetails>(),
        Definition::read::<refusal::AgentResolutionRefusedDetails>().checked(),
        Definition::read::<refusal::AgentUpdateRefusedReason>(),
        Definition::read::<refusal::AgentUpdateRefusedDetails>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
