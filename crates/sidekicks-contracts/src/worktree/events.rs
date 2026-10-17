//! Worktree event payloads beyond the shared lifecycle payload: a worktree created and retired, a
//! session swept back to the repository root, and a session's branch changed.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::gitflow::shared::GitRefName;
use crate::repo::mount::{RepoMountId, lifecycle_payload};
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::{NullableSchema, True, nullable};
use crate::worktree::lifecycle::{RemovedWorktreeId, WorktreeId, WorktreeState};

lifecycle_payload! {
    /// `worktree.created`'s payload, naming on a put-back the kept copy the tree came from, so no
    /// event type of its own is needed.
    pub struct WorktreeCreatedPayload(WorktreeState) {
        /// The kept copy a put-back restored.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "RemovedWorktreeId")]
        pub restored_from: Option<RemovedWorktreeId>,
    }
}

lifecycle_payload! {
    /// `worktree.retired`'s payload, naming the kept copy when the removal was a discard that kept
    /// one.
    pub struct WorktreeRetiredPayload(WorktreeState) {
        /// The kept copy.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "RemovedWorktreeId")]
        pub removed_worktree_id: Option<RemovedWorktreeId>,
    }
}

/// `session.sweptToCheckout`'s payload, appended to each session a removal moved back to the
/// repository root. It records a move, not a state change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSweptToRepoRootPayload {
    /// The session moved.
    pub session_id: SessionId,
    /// The mount.
    pub repo_mount_id: RepoMountId,
    /// The removed tree.
    pub worktree_id: WorktreeId,
    /// Present when the same removal cleared a pending working-folder move that pointed at it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "True")]
    pub pending_move_cleared: Option<True>,
}

/// `session.branch.changed`'s payload: the branch a session's folder is on changed outside the app,
/// and the daemon wrote it back to the session's record; one is appended to each session standing
/// in that folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionBranchChangedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The mount.
    pub repo_mount_id: RepoMountId,
    /// The tree, `null` for the repository's own checkout.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<WorktreeId>")]
    pub worktree_id: Option<WorktreeId>,
    /// The branch now, `null` while HEAD is detached.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<GitRefName>")]
    pub branch: Option<GitRefName>,
    /// The branch before, `null` while HEAD was detached.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<GitRefName>")]
    pub previous_branch: Option<GitRefName>,
}

/// The TypeScript module of worktree event payloads beyond the shared lifecycle payload.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "worktree/events",
    doc: "Worktree event payloads beyond the shared lifecycle payload: a worktree created and \
          retired, a session swept back to the repository root, and a session's branch changed.",
    definitions: &[
        Definition::read::<WorktreeCreatedPayload>().checked(),
        Definition::read::<WorktreeRetiredPayload>().checked(),
        Definition::read::<SessionSweptToRepoRootPayload>().checked(),
        Definition::read::<SessionBranchChangedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
