//! Skills: the list of every skill folder, file reads and saves, the name a typed skill would be
//! called by, availability per provider, the scan a widening runs, and the refusals of those
//! methods. A skill is its whole folder. The daemon parses every `SKILL.md` itself because a
//! provider can load a broken one without a word, so a provider's own skill listing is evidence of
//! what it loaded, never a second registry. Skills are node-local configuration: no method here
//! appends an event.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::agent::definition::{
    AGENT_REASON_MAX_LEN, AgentDefinitionOrigin, AgentDefinitionScope, add_plugin_origin_rule,
    add_project_scope_rule, plugin_name_matches_origin, project_matches_scope,
};
use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::internal::branded::branded_uuid_id;
use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::project::ProjectId;
use crate::provider::driver::length_limits::DRIVER_TOOL_NAME_MAX_LEN;
use crate::provider::name::ProviderName;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::SafeInt;
use crate::wire::text::{BoundedText, FreeFormText, NonBlankText, NonEmptyText};
use crate::wire::{NullableSchema, True, nullable};

ts_constants! {
    /// The longest name a new skill takes: Codex refuses to load a skill whose name is longer,
    /// and a new skill is available on both providers.
    pub const SKILL_NAME_MAX_LEN: usize = 64;
    /// Every reason a path can be refused.
    SKILL_PATH_REFUSED_REASONS = SkillPathRefusedReason::VARIANTS;
    /// Every reason a write can be refused.
    SKILL_WRITE_REFUSED_REASONS = SkillWriteRefusedReason::VARIANTS;
}

/// The longest account of what a tool does instead on the provider a skill is widened onto.
const SKILL_SCAN_TOOL_INSTEAD_MAX_LEN: usize = 1024;

branded_uuid_id! {
    /// A skill's daemon-minted id: the handle every method takes. Never its folder path, which is
    /// display data only, and never its name, which two origins can share.
    SkillId
}

/// A file's path inside its skill folder, relative to the folder, as the daemon judges it.
pub type SkillFilePath = FreeFormText<FILE_PATH_MAX_LEN>;

/// A folder's path; display data only, never a capability.
pub type SkillFolderPath = FreeFormText<FILE_PATH_MAX_LEN>;

/// A new skill's name, before the daemon folds it into a folder name.
pub type NewSkillName = FreeFormText<SKILL_NAME_MAX_LEN>;

/// What a person types to call a skill on one provider.
pub type SkillCallForm = FreeFormText<DRIVER_TOOL_NAME_MAX_LEN>;

/// Which providers a skill reaches, every provider named. Defaulted by origin: a skill authored
/// here is on both, one found in a provider's own folder is on that provider alone, and a plugin's
/// is on the provider the plugin was installed for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillAvailability {
    /// On Claude Code.
    pub claude: bool,
    /// On Codex.
    pub codex: bool,
}

/// What a person types to call the skill, per provider it reaches, in that provider's own form: a
/// provider's own folder keeps its bare name there (`/security-review`, `$refactor-plan`), a skill
/// made in the app arrives as `sidekicks:<name>`, a skill crossing to the other provider under its
/// origin's plugin name (`$claude:security-review`), and a plugin's skill under the plugin's name
/// on both. The daemon derives it; the composer inserts it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillCallForms {
    /// On Claude Code.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SkillCallForm")]
    pub claude: Option<SkillCallForm>,
    /// On Codex.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SkillCallForm")]
    pub codex: Option<SkillCallForm>,
}

/// One file in a skill folder, `SKILL.md` included. `size` is in bytes; `readable` is false for a
/// binary file, which the editor does not open but the folder still lists, because the folder
/// travels whole.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillFile {
    /// Its path in the folder.
    pub path: SkillFilePath,
    /// Its size in bytes.
    pub size: SafeInt<0>,
    /// Whether the editor can open it.
    pub readable: bool,
}

/// One skill as the list serves it. A plugin's skill, which is read-only, names its plugin and no
/// other does; a project skill names its project and no other does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(entry_names_its_plugin_and_project))]
#[schemars(transform = add_plugin_origin_rule, transform = add_project_scope_rule)]
pub struct SkillListEntry {
    /// The skill.
    pub skill_id: SkillId,
    /// The front matter's name, or the folder's where it has none.
    pub name: FreeFormText<FILE_PATH_MAX_LEN>,
    /// `null` when `SKILL.md` carries none, or the record is orphaned.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<String>")]
    pub description: Option<String>,
    /// A glyph key kept in our record on every origin; `null` draws the default mark.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<NonEmptyText>")]
    pub icon: Option<NonEmptyText>,
    /// Which files it came from.
    pub origin: AgentDefinitionOrigin,
    /// The plugin, on a plugin's skill.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_TOOL_NAME_MAX_LEN>")]
    pub plugin_name: Option<FreeFormText<DRIVER_TOOL_NAME_MAX_LEN>>,
    /// Every project, or one.
    pub scope: AgentDefinitionScope,
    /// The project, on a project skill.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProjectId")]
    pub project_id: Option<ProjectId>,
    /// The folder, or for an orphaned record the last path it was known at.
    pub folder_path: SkillFolderPath,
    /// Every file in the folder; empty for an orphaned record.
    pub files: Vec<SkillFile>,
    /// Which providers it reaches.
    pub availability: SkillAvailability,
    /// What a person types to call it.
    pub call_forms: SkillCallForms,
    /// The folder was renamed or deleted outside the app; the record keeps its availability and
    /// icon until it is reattached or discarded.
    pub orphaned: bool,
    /// The providers whose own configuration switches it off.
    pub disabled_in_provider: Vec<ProviderName>,
    /// The daemon's own parse failed, with the reason; `null` otherwise.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<FreeFormText<AGENT_REASON_MAX_LEN>>")]
    pub load_error: Option<FreeFormText<AGENT_REASON_MAX_LEN>>,
}

fn entry_names_its_plugin_and_project(entry: &SkillListEntry, (): &()) -> garde::Result {
    plugin_name_matches_origin(entry.origin, entry.plugin_name.as_ref())?;
    project_matches_scope(Some(entry.scope), entry.project_id.as_ref())
}

/// `skill.list` and `skill.subscribe` take no members.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SkillListRequest {}

/// Every skill folder across the four origins, orphaned records included. A file the daemon
/// cannot read is listed, never a reason to refuse the read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillListResponse {
    /// Every skill.
    #[garde(dive)]
    pub skills: Vec<SkillListEntry>,
}

/// One skill as it stands after `skill.create`, `skill.update` or `skill.recordReattach`, under
/// its final folder name, so a client never merges its own patch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillEntryResponse {
    /// The skill.
    #[garde(dive)]
    pub skill: SkillListEntry,
}

/// `skill.fileRead`: one file's body, loaded when the file opens in the editor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SkillFileReadRequest {
    /// The skill.
    pub skill_id: SkillId,
    /// The file.
    pub path: SkillFilePath,
}

/// The file's text as it is on disk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillFileReadResponse {
    /// The text.
    pub content: String,
}

/// A file written with this body: new to the folder, or changed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SkillFileWrite {
    /// The file.
    pub path: SkillFilePath,
    /// Its body.
    pub content: String,
}

/// A file moved from `renamedFrom` to `path`. It keeps its body unless `content` carries a new
/// one, so a file that cannot be read can still be renamed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SkillFileRename {
    /// Where it moves to.
    pub path: SkillFilePath,
    /// Where it was.
    pub renamed_from: SkillFilePath,
    /// Its new body.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub content: Option<String>,
}

/// One change a save makes to a file other than `SKILL.md`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum SkillFileChange {
    /// A file written.
    Write(SkillFileWrite),
    /// A file moved.
    Rename(SkillFileRename),
}

/// `skill.create`: a new skill, written whole in one save under the scope's
/// `.ai-sidekicks/skills/`: the name folded into the folder name (case folded, anything but letters
/// and digits to hyphens), and a colliding folder suffixed rather than overwritten; a folder named
/// `new` keeps its name. `description` and `body` become `SKILL.md` and `files` are the other
/// files. It is available on both providers. `scope` defaults to `global`; a project scope names
/// its project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|request: &Self, (): &()| {
    project_matches_scope(request.scope, request.project_id.as_ref())
}))]
#[schemars(transform = add_project_scope_rule)]
pub struct SkillCreateRequest {
    /// Its name.
    pub name: NewSkillName,
    /// Its description: a new skill reaches both providers, and Codex refuses to load a skill
    /// without one.
    pub description: NonBlankText,
    /// The body of `SKILL.md`.
    pub body: String,
    /// Its icon, or `null` for the default mark.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    #[schemars(with = "NullableSchema<NonEmptyText>")]
    pub icon: Option<Option<NonEmptyText>>,
    /// The other files.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<SkillFileWrite>")]
    pub files: Option<Vec<SkillFileWrite>>,
    /// Every project, or one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AgentDefinitionScope")]
    pub scope: Option<AgentDefinitionScope>,
    /// The project, on a project scope.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProjectId")]
    pub project_id: Option<ProjectId>,
}

/// `skill.update`: the folder saved whole, applied together or not at all, and the same result
/// when saved twice. `description` and `body` rewrite `SKILL.md` and keep its other front-matter
/// keys; `files` and `removedPaths` never name `SKILL.md`; `icon` goes to our record. `name`
/// renames a folder of ours; a provider's own folder is edited in place and gains nothing of ours.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SkillUpdateRequest {
    /// The skill.
    pub skill_id: SkillId,
    /// Its new name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NewSkillName")]
    pub name: Option<NewSkillName>,
    /// Its description.
    pub description: String,
    /// The body of `SKILL.md`.
    pub body: String,
    /// The changed files.
    pub files: Vec<SkillFileChange>,
    /// The removed files.
    pub removed_paths: Vec<SkillFilePath>,
    /// Its icon, or `null` for the default mark.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<NonEmptyText>")]
    pub icon: Option<NonEmptyText>,
}

/// `skill.callFormRead`: the name a skill of ours would be called by, read while its name is typed
/// and before any save: the typed `name`, folded as `skill.create` folds it, at `scope` (default
/// `global`; a project scope names its project). `skillId` names the folder being edited, so it is
/// never its own collision; a new skill sends none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|request: &Self, (): &()| {
    project_matches_scope(request.scope, request.project_id.as_ref())
}))]
#[schemars(transform = add_project_scope_rule)]
pub struct SkillCallFormReadRequest {
    /// The typed name.
    pub name: NewSkillName,
    /// Every project, or one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AgentDefinitionScope")]
    pub scope: Option<AgentDefinitionScope>,
    /// The project, on a project scope.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProjectId")]
    pub project_id: Option<ProjectId>,
    /// The folder being edited.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SkillId")]
    pub skill_id: Option<SkillId>,
}

/// The other folder of ours a name would share its packed name with, one global and one project.
/// Both still pack and nothing is refused; `callForms` is what the other folder is called by once
/// the typed one is saved, the project one taking the `-2` suffix.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillCallFormCollision {
    /// The other folder's skill.
    pub skill_id: SkillId,
    /// Its scope.
    pub scope: AgentDefinitionScope,
    /// Its folder.
    pub folder_path: SkillFolderPath,
    /// What it is called by once the typed one is saved.
    pub call_forms: SkillCallForms,
}

/// What the typed name would be called by on each provider once saved, derived by the same code
/// that builds the session pack, and the folder it collides with, or `null` when none does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillCallFormReadResponse {
    /// What it would be called by.
    pub call_forms: SkillCallForms,
    /// The folder it collides with, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<SkillCallFormCollision>")]
    pub collision: Option<SkillCallFormCollision>,
}

/// `skill.availabilityUpdate`: sets one provider on or off, with no lock: a provider's own skill
/// can be switched off its home provider, and a skill can be off everywhere.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SkillAvailabilityUpdateRequest {
    /// The skill.
    pub skill_id: SkillId,
    /// The provider.
    pub provider: ProviderName,
    /// Whether it is on.
    pub available: bool,
}

/// The availability the record now holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillAvailabilityUpdateResponse {
    /// The availability.
    pub availability: SkillAvailability,
}

/// `skill.scan`: the scan a widening runs: the folder, and the provider it is widened onto.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SkillScanRequest {
    /// The skill.
    pub skill_id: SkillId,
    /// The provider it is widened onto.
    pub provider: ProviderName,
}

/// One other provider's tool a file names: its name as words in sentence case, never its wire
/// spelling, and what will happen instead on the provider the skill is widened onto, in words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillScanTool {
    /// The tool, in words.
    pub name: FreeFormText<DRIVER_TOOL_NAME_MAX_LEN>,
    /// What happens instead.
    pub what_happens_instead: FreeFormText<SKILL_SCAN_TOOL_INSTEAD_MAX_LEN>,
}

/// One file that names the other provider's tools or its call sigil. The file is named, never the
/// line, because a line offset goes stale when the file is edited outside the app.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillScanFinding {
    /// The file.
    pub path: SkillFilePath,
    /// The tools it names.
    pub tools: Vec<SkillScanTool>,
    /// Whether it names the other provider's call sigil.
    pub call_sigil: bool,
}

/// Every file the scan found something in; empty when the folder names no other provider's tools.
/// A read that stores nothing: the warning it feeds is derived from the availability setting and
/// never kept.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillScanResponse {
    /// The findings.
    pub findings: Vec<SkillScanFinding>,
}

/// `skill.recordReattach`: reattaches an orphaned record (its availability and icon) to a folder,
/// accepted only while the record is orphaned. The renderer sends the folder chooser's token and
/// main forwards the path in its place, so `folderPath` is the path the daemon reads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SkillRecordReattachRequest {
    /// The skill.
    pub skill_id: SkillId,
    /// The folder.
    pub folder_path: SkillFolderPath,
}

/// `skill.recordDiscard`: drops an orphaned record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SkillRecordDiscardRequest {
    /// The skill.
    pub skill_id: SkillId,
}

/// A discard's answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillRecordDiscardResponse {
    /// Always true.
    pub discarded: True,
}

/// Why `skill.path_refused` refused. A save's path would land outside the folder, the folder
/// already holds it, or it names `SKILL.md`, which a folder always has exactly one of and which is
/// never replaced, renamed or removed. A send's picked skill matches no row of `skill.list` by name
/// and folder, so the provider is never handed a file the daemon does not list.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "snake_case")]
pub enum SkillPathRefusedReason {
    /// It would land outside the folder.
    EscapesFolder,
    /// The folder already holds it.
    DuplicatePath,
    /// It names `SKILL.md`.
    NamesEntryFile,
    /// A send's picked skill is not a row of `skill.list`.
    NotListed,
}

/// The `skill.path_refused` refusal's details: the refused path and why, so the skill editor
/// answers in the row it was typed into.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillPathRefusedDetails {
    /// The path.
    pub path: BoundedText<0, FILE_PATH_MAX_LEN>,
    /// Why.
    pub reason: SkillPathRefusedReason,
}

/// Why `skill.write_refused` refused: every method that writes refuses a plugin's skill, which is
/// read-only, and `skill.recordReattach` refuses a record that is not orphaned.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "snake_case")]
pub enum SkillWriteRefusedReason {
    /// A plugin's skill is read-only.
    PluginReadOnly,
    /// The record is not orphaned.
    NotOrphaned,
}

/// The `skill.write_refused` refusal's details.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillWriteRefusedDetails {
    /// Why.
    pub reason: SkillWriteRefusedReason,
}

/// The `skill.name_taken` refusal's details: the folder already holding the name, so the screen
/// names it under the Name field.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillNameTakenDetails {
    /// The folder.
    pub folder_path: BoundedText<0, FILE_PATH_MAX_LEN>,
}

methods! {
    /// The `skill.*` methods. `skill.subscribe` resends the whole `skill.list` reply each time a
    /// save from any window or the daemon's watch over the skill folders changes it.
    pub const SKILL_METHOD_DESCRIPTORS = [
        /// Every skill folder.
        SkillList = query "skill.list" {
            mutating: false,
            params: SkillListRequest,
            result: SkillListResponse,
            refusals: [],
        },
        /// Every skill folder, resent on each change.
        SkillSubscribe = subscription "skill.subscribe" {
            mutating: false,
            params: SkillListRequest,
            result: SubscribeAckResponse,
            emission: SkillListResponse,
            refusals: [],
        },
        /// One file's body.
        SkillFileRead = query "skill.fileRead" {
            mutating: false,
            params: SkillFileReadRequest,
            result: SkillFileReadResponse,
            refusals: [],
        },
        /// Creates a skill.
        SkillCreate = mutation "skill.create" {
            mutating: true,
            params: SkillCreateRequest,
            result: SkillEntryResponse,
            refusals: [SkillPathRefused],
        },
        /// Saves a skill's folder whole.
        SkillUpdate = mutation "skill.update" {
            mutating: true,
            params: SkillUpdateRequest,
            result: SkillEntryResponse,
            refusals: [SkillPathRefused, SkillWriteRefused, SkillNameTaken],
        },
        /// The name a typed skill would be called by.
        SkillCallFormRead = query "skill.callFormRead" {
            mutating: false,
            params: SkillCallFormReadRequest,
            result: SkillCallFormReadResponse,
            refusals: [],
        },
        /// Sets one provider on or off.
        SkillAvailabilityUpdate = mutation "skill.availabilityUpdate" {
            mutating: true,
            params: SkillAvailabilityUpdateRequest,
            result: SkillAvailabilityUpdateResponse,
            refusals: [SkillWriteRefused],
        },
        /// The scan a widening runs.
        SkillScan = query "skill.scan" {
            mutating: false,
            params: SkillScanRequest,
            result: SkillScanResponse,
            refusals: [],
        },
        /// Reattaches an orphaned record.
        SkillRecordReattach = mutation "skill.recordReattach" {
            mutating: true,
            params: SkillRecordReattachRequest,
            result: SkillEntryResponse,
            refusals: [SkillWriteRefused],
        },
        /// Drops an orphaned record.
        SkillRecordDiscard = mutation "skill.recordDiscard" {
            mutating: true,
            params: SkillRecordDiscardRequest,
            result: SkillRecordDiscardResponse,
            refusals: [SkillWriteRefused],
        },
    ];
}

/// The TypeScript module of skills.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "skill",
    doc: "Skills: every skill folder, file reads and saves, call forms, availability per \
          provider, the scan a widening runs, and their refusals.",
    definitions: &[
        Definition::read::<SkillId>().checked(),
        Definition::read::<SkillAvailability>().checked(),
        Definition::read::<SkillCallForms>().checked(),
        Definition::read::<SkillFile>(),
        Definition::read::<SkillListEntry>().checked(),
        Definition::read::<SkillListRequest>(),
        Definition::read::<SkillListResponse>(),
        Definition::read::<SkillEntryResponse>(),
        Definition::read::<SkillFileReadRequest>(),
        Definition::read::<SkillFileReadResponse>(),
        Definition::read::<SkillFileChange>().checked(),
        Definition::read::<SkillCreateRequest>().checked(),
        Definition::read::<SkillUpdateRequest>().checked(),
        Definition::read::<SkillCallFormReadRequest>().checked(),
        Definition::read::<SkillCallFormCollision>(),
        Definition::read::<SkillCallFormReadResponse>(),
        Definition::read::<SkillAvailabilityUpdateRequest>(),
        Definition::read::<SkillAvailabilityUpdateResponse>(),
        Definition::read::<SkillScanRequest>(),
        Definition::read::<SkillScanTool>(),
        Definition::read::<SkillScanFinding>(),
        Definition::read::<SkillScanResponse>(),
        Definition::read::<SkillRecordReattachRequest>(),
        Definition::read::<SkillRecordDiscardRequest>(),
        Definition::read::<SkillRecordDiscardResponse>(),
        Definition::read::<SkillPathRefusedReason>(),
        Definition::read::<SkillPathRefusedDetails>().checked(),
        Definition::read::<SkillWriteRefusedReason>(),
        Definition::read::<SkillWriteRefusedDetails>(),
        Definition::read::<SkillNameTakenDetails>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&SKILL_METHOD_DESCRIPTORS],
};
