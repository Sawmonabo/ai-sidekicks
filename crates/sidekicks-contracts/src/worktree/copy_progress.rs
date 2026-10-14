//! The copies across volumes a removal or a put-back makes, while they run. A removal or a put-back
//! moves a tree by one rename, which reports nothing; only where the rename would cross a volume
//! does the daemon copy the tree, and only then is there progress to show.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::project::ProjectId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;
use crate::worktree::lifecycle::{RemovedWorktreeId, WorktreeId};

/// `repo.worktreeCopySubscribe`: one project's copies under way, or every project's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorktreeCopySubscribeRequest {
    /// The project; absent follows every project.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProjectId")]
    pub project_id: Option<ProjectId>,
}

/// One copy under way, by the row it draws on: a worktree being removed, by its `repo.mountList`
/// and `repo.worktreeStatusRead` id, or a kept worktree being put back, by its
/// `repo.removedWorktreeList` id. The bytes written count the file being copied.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorktreeCopy {
    /// A worktree being removed.
    Removing {
        /// The worktree.
        worktree_id: WorktreeId,
        /// Its project.
        project_id: ProjectId,
        /// The name its row shows.
        name: FreeFormText<FILE_PATH_MAX_LEN>,
        /// Bytes written so far.
        copied_bytes: SafeInt<0>,
        /// Bytes of every file it makes.
        total_bytes: SafeInt<0>,
    },
    /// A kept worktree being put back.
    PuttingBack {
        /// The kept worktree.
        removed_worktree_id: RemovedWorktreeId,
        /// Its project.
        project_id: ProjectId,
        /// The name its row shows.
        name: FreeFormText<FILE_PATH_MAX_LEN>,
        /// Bytes written so far.
        copied_bytes: SafeInt<0>,
        /// Bytes of every file it makes.
        total_bytes: SafeInt<0>,
    },
}

/// One `repo.worktreeCopySubscribe` emission: every copy under way, sent whole on each change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorktreeCopyProgress {
    /// The copies.
    pub copies: Vec<WorktreeCopy>,
}

/// The TypeScript module of the copies across volumes a removal or a put-back makes.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "worktree/copy-progress",
    doc: "The copies across volumes a removal or a put-back makes, while they run.",
    definitions: &[
        Definition::read::<WorktreeCopySubscribeRequest>(),
        Definition::read::<WorktreeCopy>(),
        Definition::read::<WorktreeCopyProgress>(),
    ],
    constants: &[],
    method_tables: &[],
};
