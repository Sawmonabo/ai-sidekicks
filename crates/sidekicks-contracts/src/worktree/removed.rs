//! The copies `Discard and remove` keeps: listing them, putting one back and deleting one. The
//! discard moves the tree whole into its project's kept folder, so nothing it held is lost; the
//! copy stays until the person presses `Delete now`, and nothing deletes it on its own.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use crate::gitflow::shared::GitRefName;
use crate::project::ProjectId;
use crate::repo::git_reads::GitObjectId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;
use crate::wire::{NullableSchema, nullable};
use crate::worktree::lifecycle::{RemovedWorktreeId, WorktreeId};

/// `repo.removedWorktreeList`: one project's kept worktrees, or every project's, plus what is left
/// of a copy put back while it is the one source to rebuild a live tree git cannot read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RemovedWorktreeListRequest {
    /// The project; absent lists every project's.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProjectId")]
    pub project_id: Option<ProjectId>,
}

/// One kept worktree. Its size is read once after the discard, so `sizeBytes` and `sizeReadAt` are
/// `null` until that read has run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RemovedWorktree {
    /// The kept worktree.
    pub removed_worktree_id: RemovedWorktreeId,
    /// Its project.
    pub project_id: ProjectId,
    /// The tree's name.
    pub name: FreeFormText<FILE_PATH_MAX_LEN>,
    /// Its branch.
    pub branch: GitRefName,
    /// The commit it stood on.
    pub head_commit: GitObjectId,
    /// When it was removed.
    #[garde(dive)]
    pub removed_at: WireInstant,
    /// Its size in bytes, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<SafeInt<0>>")]
    pub size_bytes: Option<SafeInt<0>>,
    /// When its size was read, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<WireInstant>")]
    #[garde(dive)]
    pub size_read_at: Option<WireInstant>,
    /// The folder of the live tree put back from this copy that git cannot read, the one case a
    /// copy put back is listed; `null` otherwise.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<FilesystemPath>")]
    pub unreadable_put_back_folder: Option<FilesystemPath>,
}

/// The `repo.removedWorktreeList` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemovedWorktreeListResponse {
    /// The kept worktrees.
    #[garde(dive)]
    pub removed_worktrees: Vec<RemovedWorktree>,
}

/// `repo.worktreeRestore` and `repo.removedWorktreeDelete`: the kept worktree to put back or
/// delete.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RemovedWorktreeRequest {
    /// The kept worktree.
    pub removed_worktree_id: RemovedWorktreeId,
}

/// Why a put-back was refused; a refused put-back keeps the copy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "reason",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorktreeRestoreRefusal {
    /// The project is no longer attached.
    ProjectNotAttached {},
    /// The repository is no longer at `path`.
    RepositoryMissing {
        /// Where the repository was.
        path: FilesystemPath,
    },
    /// The kept folder no longer holds the tree, so only `Delete now` is left for it.
    KeptTreeMissing {},
}

/// The `repo.worktreeRestore` result: the tree made again, or the refusal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorktreeRestoreResponse {
    /// The tree made again at `path`, its own folder or the first free numbered `<name>-restored`
    /// (`-restored-2` and on), on its own branch, or on the new `<branch>-restored` of the same
    /// number when its branch has moved since or another worktree holds it (`onNewBranch`).
    Restored {
        /// The new worktree.
        worktree_id: WorktreeId,
        /// Its folder.
        path: FilesystemPath,
        /// Its branch.
        branch: GitRefName,
        /// Whether the branch is a new one.
        on_new_branch: bool,
    },
    /// The put-back was refused.
    Refused {
        /// Why.
        refusal: WorktreeRestoreRefusal,
    },
}

/// The TypeScript module of the copies Discard and remove keeps.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "worktree/removed",
    doc: "The copies Discard and remove keeps: listing them, putting one back and deleting one.",
    definitions: &[
        Definition::read::<RemovedWorktreeListRequest>(),
        Definition::read::<RemovedWorktree>(),
        Definition::read::<RemovedWorktreeListResponse>(),
        Definition::read::<RemovedWorktreeRequest>(),
        Definition::read::<WorktreeRestoreRefusal>(),
        Definition::read::<WorktreeRestoreResponse>(),
    ],
    constants: &[],
    method_tables: &[],
};
