//! A worktree's ids, state and lifecycle payload, and the requests and responses of
//! `workspace.executionRoot.prepare`, `worktree.retire` with the details of its refusals, and
//! `worktree.status.read`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::agent::definition::AgentId;
use crate::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use crate::git::shared::GitRefName;
use crate::internal::branded::branded_uuid_id;
use crate::project::ProjectId;
use crate::repo::mount::{RepoMountId, WorkspaceId, WorkspaceState, lifecycle_payload};
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::literal;
use crate::wire::text::FreeFormText;
use crate::wire::{NullableSchema, nullable};

branded_uuid_id! {
    /// The daemon-minted id of a worktree row.
    WorktreeId
}

branded_uuid_id! {
    /// The daemon-minted id of a branch context: the workspace-anchored branch record.
    BranchContextId
}

branded_uuid_id! {
    /// The id of a worktree removed with `Discard and remove` and kept whole until the person
    /// deletes the copy; a record apart from the retired worktree, since the copy outlives the tree
    /// and a put-back makes a new worktree.
    RemovedWorktreeId
}

/// A worktree's lifecycle state. `retired` and `failed` are not live; moving to `failed` emits no
/// `worktree.*` event (the failure is evented as `workspace.rootLost`), and failed rows stay
/// readable through `worktree.status.read`.
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
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum WorktreeState {
    /// Being made.
    Creating,
    /// Ready.
    Ready,
    /// Holding uncommitted work.
    Dirty,
    /// Its branch was merged.
    Merged,
    /// Removed.
    Retired,
    /// Making it failed.
    Failed,
}

/// The state of a listed worktree: every state but `retired`, since a retired tree is never listed.
/// It is a wire enum of its own so a client's table keyed by it covers exactly the listed states;
/// the conversion from [`WorktreeState`] matches every state, so the two cannot drift apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ListedWorktreeState {
    /// Being made.
    Creating,
    /// Ready.
    Ready,
    /// Holding uncommitted work.
    Dirty,
    /// Its branch was merged.
    Merged,
    /// Making it failed.
    Failed,
}

impl TryFrom<WorktreeState> for ListedWorktreeState {
    /// A retired tree is never listed.
    type Error = RetiredWorktreeState;

    fn try_from(state: WorktreeState) -> Result<Self, Self::Error> {
        match state {
            WorktreeState::Creating => Ok(Self::Creating),
            WorktreeState::Ready => Ok(Self::Ready),
            WorktreeState::Dirty => Ok(Self::Dirty),
            WorktreeState::Merged => Ok(Self::Merged),
            WorktreeState::Failed => Ok(Self::Failed),
            WorktreeState::Retired => Err(RetiredWorktreeState::Value),
        }
    }
}

lifecycle_payload! {
    /// The payload of a `worktree.*` lifecycle event; the emitter sets `worktreeId` on every one.
    pub struct WorktreeLifecyclePayload(WorktreeState) {}
}

/// `workspace.executionRoot.prepare`: the workspace and its branch, which makes the root for the
/// workspace's execution mode before a run starts. It carries no run id: the daemon supplies it, so
/// a caller cannot forge run provenance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkspaceExecutionRootPrepareRequest {
    /// The workspace.
    pub workspace_id: WorkspaceId,
    /// The branch; omitting it draws `workspace.branchNameRequired` before any git call.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "GitRefName")]
    pub branch_name: Option<GitRefName>,
    /// The base; absent means the mount's current branch, and a detached HEAD with no base is
    /// refused. The daemon refuses a leading dash before git reads it as an option.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "GitRefName")]
    pub base_ref: Option<GitRefName>,
    /// Carries the session's uncommitted work, untracked files included, onto the new tree; refused
    /// unless the new base is the branch the work sits on.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub carry_uncommitted: Option<bool>,
}

/// The `workspace.executionRoot.prepare` result: the prepared root and the rows it names. A prepare
/// resolves a root or refuses; there is no partial success.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkspaceExecutionRootPrepareResponse {
    /// The root.
    pub execution_root: FilesystemPath,
    /// The workspace's state.
    pub state: WorkspaceState,
    /// The worktree, for a `provisionedWorktree` prepare only.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorktreeId")]
    pub worktree_id: Option<WorktreeId>,
    /// The branch context every prepare writes or refreshes.
    pub branch_context_id: BranchContextId,
}

/// `worktree.retire`. `discard: false` is the ordinary removal: it removes nothing the confirm
/// did not show, and is refused with the current risks when the tree changed since they were
/// read. `discard: true` comes only from the discard confirm, and the daemon keeps the tree whole
/// instead of deleting it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorktreeRetireRequest {
    /// The worktree.
    pub worktree_id: WorktreeId,
    /// Whether to keep the tree whole instead of deleting it.
    pub discard: bool,
}

literal! {
    /// The state a retired worktree reads.
    pub enum RetiredWorktreeState = "retired";
}

/// The kept copy a discard made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeptWorktree {
    /// The kept copy.
    pub removed_worktree_id: RemovedWorktreeId,
}

/// The `worktree.retire` result: the worktree, now `retired`, and the kept copy when a discard
/// kept one. A refusal is an error, never a reply with the unchanged state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorktreeRetireResponse {
    /// The worktree.
    pub worktree_id: WorktreeId,
    /// Its state.
    pub state: RetiredWorktreeState,
    /// The kept copy.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "KeptWorktree")]
    pub kept: Option<KeptWorktree>,
}

/// What removing a tree would lose, each named in the confirm: uncommitted files, ignored files (an
/// `.env`, say), commits no remote-tracking branch of the folder reaches, and the sessions standing
/// in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeRemovalRisks {
    /// Uncommitted files.
    pub uncommitted_file_count: SafeInt<0>,
    /// Ignored files that would be destroyed.
    pub ignored_file_count: SafeInt<0>,
    /// Commits no remote-tracking branch reaches.
    pub unpushed_commit_count: SafeInt<0>,
    /// The sessions standing in it.
    pub occupying_session_ids: Vec<SessionId>,
}

/// The details of a `worktree.retireConflict` refusal, by why the removal was refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "reason",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorktreeRetireConflictDetails {
    /// An agent runs in the tree.
    RootBusy {
        /// The worktree.
        worktree_id: WorktreeId,
        /// The session the agent runs in.
        running_session_id: SessionId,
    },
    /// The tree has something to lose, ignored files included; the current risks let the confirm
    /// redraw them.
    HasChanges {
        /// The worktree.
        worktree_id: WorktreeId,
        /// What removing it would lose now.
        risks: WorktreeRemovalRisks,
    },
}

/// The details of a `worktree.retireIncomplete` refusal: the tree, still live, and the kept copy
/// listed for it. No folder is named; the screen finds both from the lists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeRetireIncompleteDetails {
    /// The worktree.
    pub worktree_id: WorktreeId,
    /// The kept copy.
    pub removed_worktree_id: RemovedWorktreeId,
}

literal! {
    /// The reason a carry was refused because a run is live in its checkout.
    pub enum CarryCheckoutRunningReason = "carryCheckoutRunning";
}

/// The details of a `worktree.createFailed` refusal with reason `carryCheckoutRunning`: the
/// session whose run is live in the checkout the work would be carried from, and that run's agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeCarryCheckoutRunningDetails {
    /// Why.
    pub reason: CarryCheckoutRunningReason,
    /// The session running there.
    pub running_session_id: SessionId,
    /// Its agent.
    pub running_agent_id: AgentId,
}

/// Declares [`WorktreeStatusRecord`]: each arm's own members, then the members every arm repeats.
macro_rules! worktree_status_record {
    ($($(#[doc = $doc:literal])+ $arm:ident { $($own:tt)* })+) => {
        /// One worktree git lists for the repository, with every figure its switcher row draws;
        /// `path` is the folder `session.workingFolder.update` takes. A tree the app made carries
        /// its record, and one the person made carries none and has no removal of its own.
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(
            tag = "madeBy",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        pub enum WorktreeStatusRecord {$(
            $(#[doc = $doc])+
            $arm {
                $($own)*
                /// The tree's folder.
                path: FilesystemPath,
                /// Its name.
                name: FreeFormText<FILE_PATH_MAX_LEN>,
                /// Its branch.
                branch_name: GitRefName,
                /// Commits ahead of the upstream as of the last fetch; absent with no upstream.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "SafeInt<0>")]
                ahead: Option<SafeInt<0>>,
                /// Commits behind the upstream as of the last fetch; absent with no upstream.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "SafeInt<0>")]
                behind: Option<SafeInt<0>>,
                /// Uncommitted files.
                uncommitted_file_count: SafeInt<0>,
                /// Commits no remote-tracking branch reaches.
                unpushed_commit_count: SafeInt<0>,
                /// The sessions standing in it.
                occupying_session_ids: Vec<SessionId>,
                /// The session whose agent runs in it, which locks its removal, or `null`.
                #[serde(deserialize_with = "nullable")]
                #[schemars(with = "NullableSchema<SessionId>")]
                running_session_id: Option<SessionId>,
            },
        )+}
    };
}

worktree_status_record! {
    /// A tree the app made, with its record.
    App {
        /// The worktree.
        worktree_id: WorktreeId,
        /// Its mount.
        repo_mount_id: RepoMountId,
        /// The branch it was made from.
        base_branch_name: GitRefName,
        /// Its state.
        state: ListedWorktreeState,
        /// The session that made it.
        created_by_session_id: SessionId,
        /// The run that made it; absent for a tree prepared before any run.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "RunId")]
        created_by_run_id: Option<RunId>,
        /// When it was made.
        #[garde(dive)]
        created_at: WireInstant,
        /// When it last changed.
        #[garde(dive)]
        updated_at: WireInstant,
    }
    /// A tree the person made.
    Person {}
}

/// `worktree.status.read`: the project whose worktrees are listed, and the session asking, when
/// one is, so the read also answers the new-worktree form's suggestion for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorktreeStatusReadRequest {
    /// The project.
    pub project_id: ProjectId,
    /// The session asking.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionId")]
    pub session_id: Option<SessionId>,
}

/// What the new-worktree form opens with, from the daemon function that names and creates the
/// tree, so the form copies none of the daemon's naming.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewWorktreeSuggestion {
    /// The name's fixed part, from the branch pattern.
    pub fixed_part: String,
    /// A tail suggested from the session title; absent when the name has none, as for a branch
    /// name the person typed that the pattern did not make or a session with no title words.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<{ usize::MAX }>")]
    pub suggested_tail: Option<FreeFormText<{ usize::MAX }>>,
    /// The folder up to that tail.
    pub folder_before: FilesystemPath,
}

/// The project's own checkout.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoRootStatus {
    /// Its folder.
    pub path: FilesystemPath,
    /// Its branch.
    pub branch_name: GitRefName,
}

/// The `worktree.status.read` result: the project's own checkout and its standing trees from one
/// read, so no row shows a tree free that another read calls occupied. `countsAsOf` says when the
/// ahead and behind figures were last true if the last fetch failed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorktreeStatusReadResponse {
    /// The project's own checkout.
    pub repo_root: RepoRootStatus,
    /// Its standing trees.
    #[garde(dive)]
    pub worktrees: Vec<WorktreeStatusRecord>,
    /// When the figures were last true.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireInstant")]
    #[garde(dive)]
    pub counts_as_of: Option<WireInstant>,
    /// The new-worktree form's suggestion for the session asking.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NewWorktreeSuggestion")]
    pub new_worktree: Option<NewWorktreeSuggestion>,
}

/// The TypeScript module of a worktree's lifecycle and its methods' types.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "worktree/lifecycle",
    doc: "A worktree's ids, state and lifecycle payload, and the requests and responses of the \
          worktree methods: preparing an execution root, retiring a tree and the details of its \
          refusals, and reading the project's trees.",
    definitions: &[
        Definition::read::<WorktreeId>().checked(),
        Definition::read::<BranchContextId>().checked(),
        Definition::read::<RemovedWorktreeId>(),
        Definition::read::<WorktreeState>().checked(),
        Definition::read::<ListedWorktreeState>(),
        Definition::read::<WorktreeLifecyclePayload>().checked(),
        Definition::read::<WorkspaceExecutionRootPrepareRequest>().checked(),
        Definition::read::<WorkspaceExecutionRootPrepareResponse>().checked(),
        Definition::read::<WorktreeRetireRequest>().checked(),
        Definition::read::<KeptWorktree>(),
        Definition::read::<WorktreeRetireResponse>().checked(),
        Definition::read::<WorktreeRemovalRisks>(),
        Definition::read::<WorktreeRetireConflictDetails>(),
        Definition::read::<WorktreeRetireIncompleteDetails>(),
        Definition::read::<WorktreeCarryCheckoutRunningDetails>(),
        Definition::read::<WorktreeStatusRecord>(),
        Definition::read::<WorktreeStatusReadRequest>().checked(),
        Definition::read::<NewWorktreeSuggestion>(),
        Definition::read::<RepoRootStatus>(),
        Definition::read::<WorktreeStatusReadResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
