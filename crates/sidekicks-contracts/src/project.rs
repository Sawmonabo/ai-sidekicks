//! A project: the durable record beside a mount that the person names. It exists from the first
//! press of `Clone`, before any mount does, and carries its name, its setup steps, its own
//! environment rows and its own branch pattern. The row shape and the branch-pattern rule are the
//! machine settings', so a project's override is checked exactly as `Every project` is.
//!
//! `repo.projectList` is a live list: each emission carries the whole list, so a late subscriber
//! needs no resend.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::free_form_string::FilesystemPath;
use crate::internal::branded::branded_uuid_id;
use crate::machine_settings::{BranchNamePattern, BranchNamePatternChange, EnvironmentRow};
use crate::repo::mount::RepoMountId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::{BoundedInt, SafeInt};
use crate::wire::text::FreeFormText;
use crate::wire::{NullableSchema, nullable};

ts_constants! {
    /// The longest project name the daemon keeps.
    pub const PROJECT_NAME_MAX_LEN: usize = 256;
    /// The longest setup command the daemon keeps: a command line the person types, bounded
    /// generously so no command a shell accepts is refused for its length.
    pub const PROJECT_SETUP_COMMAND_MAX_LEN: usize = 8192;
}

branded_uuid_id! {
    /// The daemon-minted id of a project: the record beside a mount that the person names.
    ProjectId
}

/// A project's name.
pub type ProjectName = FreeFormText<PROJECT_NAME_MAX_LEN>;

/// A project's life: `cloning` from the first press of `Clone` until the clone attaches (a failed
/// or canceled clone stays `cloning`, so it can be run again), then `active`, and `archived` while
/// it sits in the archived group.
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
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum ProjectState {
    /// Its clone has not attached yet.
    Cloning,
    /// In use.
    Active,
    /// In the archived group.
    Archived,
}

/// What runs after a worktree is made in the project: files copied into the new tree, then
/// commands run in order, each given up on after the time limit when one is set. The steps run
/// with the repository's own git config, its hooks included, and never raise an approval, so only
/// the person writes them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSetup {
    /// Paths inside the repository copied into each new tree.
    pub files_to_copy: Vec<FilesystemPath>,
    /// Commands run in order.
    pub commands: Vec<FreeFormText<PROJECT_SETUP_COMMAND_MAX_LEN>>,
    /// Seconds each command is given up on after; absent means no limit. At most 2^31 − 1 ms in
    /// whole seconds, the longest delay a timer keeps.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BoundedInt<1, 2_147_483>")]
    pub time_limit_seconds: Option<BoundedInt<1, 2_147_483>>,
}

/// How many of a project's sessions are running, waiting on the person and done.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSessionTally {
    /// Running.
    pub running: SafeInt<0>,
    /// Waiting on the person.
    pub waiting: SafeInt<0>,
    /// Done.
    pub done: SafeInt<0>,
}

/// One project as the Projects page and the session list's project headers draw it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectListEntry {
    /// The project.
    pub project_id: ProjectId,
    /// `null` while the project is still cloning; the mount is made when the clone attaches.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<RepoMountId>")]
    pub repo_mount_id: Option<RepoMountId>,
    /// Its name.
    pub name: ProjectName,
    /// Its folder.
    pub folder_path: FilesystemPath,
    /// Its life.
    pub state: ProjectState,
    /// How many sessions it has.
    pub session_count: SafeInt<0>,
    /// A session with an agent running anywhere in the project, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<SessionId>")]
    pub running_session_id: Option<SessionId>,
    /// How many of its sessions are running, waiting on the person and done.
    pub session_tally: ProjectSessionTally,
    /// Its setup steps.
    pub setup: ProjectSetup,
    /// The project's own rows, each winning over the `Every project` row of the same name.
    pub environment_rows: Vec<EnvironmentRow>,
    /// `null` while the project follows the machine's pattern.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<BranchNamePattern>")]
    pub branch_pattern: Option<BranchNamePattern>,
    /// A folder on the other side's disk of a Windows computer with WSL, read more slowly.
    pub on_other_side_disk: bool,
}

/// One `repo.projectList` emission: every project, sent once on subscribe and again on each
/// change, so a project attached or cloned from another device appears at once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectList {
    /// Every project.
    pub projects: Vec<ProjectListEntry>,
}

/// The project an edit acts on, as every project edit's reply returns it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectEditResponse {
    /// The project as edited.
    pub project: ProjectListEntry,
}

/// `repo.projectRename`: the project's display name; the folder on disk is untouched.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProjectRenameRequest {
    /// The project.
    pub project_id: ProjectId,
    /// Its new name.
    pub name: ProjectName,
}

/// `repo.projectArchive` and `repo.projectReactivate`: the project to move into or out of the
/// archived group. Its sessions are kept either way, and archiving an archived project, or
/// reactivating an active one, changes nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProjectStateChangeRequest {
    /// The project.
    pub project_id: ProjectId,
}

/// `repo.projectSetupUpdate`: the whole setup, replacing what the project had.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProjectSetupUpdateRequest {
    /// The project.
    pub project_id: ProjectId,
    /// Its setup.
    pub setup: ProjectSetup,
}

/// `repo.projectEnvironmentUpdate`: the project's whole list of rows, replacing what it had. A row
/// whose name the environment-name rule refuses is refused with `daemon.environment_name_refused`
/// naming the row, and nothing is written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProjectEnvironmentUpdateRequest {
    /// The project.
    pub project_id: ProjectId,
    /// Its rows.
    pub environment_rows: Vec<EnvironmentRow>,
}

/// `repo.projectBranchPatternUpdate`: the project's own branch pattern, or `null` to return the
/// project to the machine's pattern. A pattern git refuses, or one that clashes with a branch in
/// the repository, is refused and nothing is written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProjectBranchPatternUpdateRequest {
    /// The project.
    pub project_id: ProjectId,
    /// Its pattern, or `null` for the machine's.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<BranchNamePatternChange>")]
    pub pattern: Option<BranchNamePatternChange>,
}

/// The TypeScript module of a project.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "project",
    doc: "A project: the durable record beside a mount that the person names, with its setup \
          steps, its own environment rows and its own branch pattern.",
    definitions: &[
        Definition::read::<ProjectId>().checked(),
        Definition::read::<ProjectState>(),
        Definition::read::<ProjectSetup>(),
        Definition::read::<ProjectSessionTally>(),
        Definition::read::<ProjectListEntry>(),
        Definition::read::<ProjectList>(),
        Definition::read::<ProjectEditResponse>(),
        Definition::read::<ProjectRenameRequest>(),
        Definition::read::<ProjectStateChangeRequest>(),
        Definition::read::<ProjectSetupUpdateRequest>(),
        Definition::read::<ProjectEnvironmentUpdateRequest>(),
        Definition::read::<ProjectBranchPatternUpdateRequest>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
