//! The `worktree.*` refusals and the two `workspace.*` refusals that preparing an execution root
//! raises, each sent on the wire by its code: the refusal's message becomes the reply's message and
//! its detail `data.fields`.
//!
//! A branch name the caller supplies that collides with a live checkout is refused, never adapted.
//! A prepare that cannot make its root is `worktree.createFailed`; a mode the mount does not offer
//! is `workspace.modeUnsupported`, so there is no `worktree.unsupported`. No path reaches a
//! message: a closed reason supplies the words, and the other messages name only opaque ids, git
//! ref names and commit ids. The one git line a message carries is git's refusal of a branch name,
//! which names only branches. A failure underneath, which can name a path, stays on the refusal for
//! the service log and never reaches the wire.

use std::borrow::Cow;
use std::error::Error;
use std::io;

use serde_json::{Map, Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::repo::mount::{RepoMountId, WorkspaceId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::worktree::lifecycle::{
    CarryCheckoutRunningReason, RemovedWorktreeId, WorktreeCarryCheckoutRunningDetails, WorktreeId,
    WorktreeRetireConflictDetails, WorktreeRetireIncompleteDetails,
};
use strum::IntoStaticStr;

use crate::run_setup_gates::RunSetupGateError;
use sidekicks_ipc::domain_error::{DomainError, refusal_fields};

/// Why making a worktree failed; closed and free of paths, so it is safe on the wire, where its
/// name is the detail's `reason`. `branchNameInvalid` and `branchNameTaken` carry git's own line
/// refusing the name, `carryFailed` how to recover the stashed work, and `carryCheckoutRunning`
/// the run in the way.
#[derive(Clone, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub enum WorktreeCreateFailureReason {
    /// The base ref begins with `-`, which git would read as an option.
    BaseRefOptionLike,
    /// No base ref was supplied and the mount's HEAD names no branch.
    BaseRefUnresolved,
    /// Git refused the branch name.
    BranchNameInvalid {
        /// Git's `fatal:` line as git printed it, with none of its `hint:` lines.
        git_line: String,
    },
    /// Git refused the branch name as taken.
    BranchNameTaken {
        /// Git's `fatal:` line as git printed it, with none of its `hint:` lines.
        git_line: String,
    },
    /// Neither the session's title nor a run id gave a branch name its tail.
    BranchNameUnderivable,
    /// The uncommitted work would be carried onto a tree cut from another branch than the one
    /// the session is on.
    CarryBaseMismatch,
    /// Another session's run is live in the checkout the work would be carried from.
    CarryCheckoutRunning {
        /// The session running there.
        running_session_id: SessionId,
        /// Its agent.
        running_agent_id: AgentId,
    },
    /// A step after the carry's stash was pushed failed; the work is kept in that stash.
    CarryFailed {
        /// How to put the stash back, naming it by its commit or its message.
        recovery: String,
    },
    /// The daemon's worktrees folder could not be prepared.
    ExecutionRootUnavailable,
    /// The git worktree call did not complete.
    GitInvocationFailed,
    /// The folder the worktree would be made in already exists.
    WorktreeFolderTaken,
}

/// Why a worktree call or an execution root's preparation was refused. Converts into the
/// [`DomainError`] the reply carries, keeping any failure underneath as its source.
#[derive(Debug, thiserror::Error)]
pub enum WorktreeRefusal {
    /// The worktree id did not resolve (`worktree.notFound`).
    #[error("worktree {worktree_id} does not exist")]
    NotFound {
        /// The worktree asked for.
        worktree_id: WorktreeId,
    },
    /// No kept copy has the id, such as one a put-back or a deletion queued before it already
    /// removed (`worktree.removed.notFound`).
    #[error("kept worktree {removed_worktree_id} does not exist")]
    RemovedNotFound {
        /// The kept copy asked for.
        removed_worktree_id: RemovedWorktreeId,
    },
    /// Making the worktree failed (`worktree.createFailed`); the workspace goes `rootLost`.
    #[error("{}", create_failed_message(.reason))]
    CreateFailed {
        /// Why.
        reason: WorktreeCreateFailureReason,
        /// The failure underneath, such as git's rejection.
        #[source]
        source: Option<Box<dyn Error + Send + Sync>>,
    },
    /// A branch name the caller supplied collides with a live checkout the daemon made on the same
    /// mount (`worktree.branchCollision`); only a creation told to refuse a taken name raises it.
    #[error(
        "worktree creation refused: branch {} already has a live checkout on repo mount {}",
        .branch_name.as_str(),
        .repo_mount_id
    )]
    BranchCollision {
        /// The mount.
        repo_mount_id: RepoMountId,
        /// The branch.
        branch_name: GitRefName,
    },
    /// A removal refused because an agent runs in the tree, or because a plain removal would lose
    /// what the tree now holds, whose current risks the confirm redraws
    /// (`worktree.retireConflict`).
    #[error("{}", retire_conflict_message(.details))]
    RetireConflict {
        /// Why, with the session running there or the current risks.
        details: WorktreeRetireConflictDetails,
    },
    /// A discard refused because the system would not move the tree aside while a program outside
    /// the app holds a file in it open; nothing was removed (`worktree.retireFolderHeld`).
    #[error(
        "worktree {} cannot be moved aside: a program outside the app holds a file",
        .worktree_id
    )]
    RetireFolderHeld {
        /// The worktree.
        worktree_id: WorktreeId,
        /// The refused move.
        #[source]
        source: io::Error,
    },
    /// A discard whose move across volumes copied the tree whole to its kept place but could not
    /// remove the original completely; the kept copy is listed and the tree stays live
    /// (`worktree.retireIncomplete`).
    #[error(
        "worktree {} was copied to kept copy {}, but its original folder could not be removed \
         completely",
        .details.worktree_id,
        .details.removed_worktree_id
    )]
    RetireIncomplete {
        /// The tree and its kept copy.
        details: WorktreeRetireIncompleteDetails,
        /// The removal's failure.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    /// Preparing the root failed at the run's setup gate, which ends the run `failed`
    /// (`workspace.executionRoot.unresolved`). The detail names the cause's code when it has one;
    /// the cause's message never reaches the wire.
    #[error("{}", execution_root_unresolved_message(.workspace_id, .cause))]
    ExecutionRootUnresolved {
        /// The workspace.
        workspace_id: WorkspaceId,
        /// Why preparing it failed.
        #[source]
        cause: RunSetupGateError,
    },
    /// A wire prepare omitted its branch name, which the daemon derives only when a run is set up
    /// (`workspace.branchNameRequired`); raised before any git call.
    #[error(
        "execution root prepare refused for workspace {}: a wire prepare must carry a branch \
         name, because the daemon derives one only when a run is set up",
        .workspace_id
    )]
    BranchNameRequired {
        /// The workspace.
        workspace_id: WorkspaceId,
    },
}

impl From<WorktreeRefusal> for DomainError {
    fn from(refusal: WorktreeRefusal) -> Self {
        let message = refusal.to_string();
        let (code, detail, source): (_, _, Option<Box<dyn Error + Send + Sync>>) = match refusal {
            WorktreeRefusal::NotFound { worktree_id } => (
                RefusalCode::WorktreeNotFound,
                refusal_fields(json!({ "worktreeId": worktree_id })),
                None,
            ),
            WorktreeRefusal::RemovedNotFound {
                removed_worktree_id,
            } => (
                RefusalCode::WorktreeRemovedNotFound,
                refusal_fields(json!({ "removedWorktreeId": removed_worktree_id })),
                None,
            ),
            WorktreeRefusal::CreateFailed { reason, source } => (
                RefusalCode::WorktreeCreateFailed,
                create_failed_detail(&reason),
                source,
            ),
            WorktreeRefusal::BranchCollision {
                repo_mount_id,
                branch_name,
            } => (
                RefusalCode::WorktreeBranchCollision,
                refusal_fields(json!({
                    "repoMountId": repo_mount_id,
                    "branchName": branch_name.as_str(),
                })),
                None,
            ),
            WorktreeRefusal::RetireConflict { details } => (
                RefusalCode::WorktreeRetireConflict,
                refusal_fields(details),
                None,
            ),
            WorktreeRefusal::RetireFolderHeld {
                worktree_id,
                source,
            } => (
                RefusalCode::WorktreeRetireFolderHeld,
                refusal_fields(json!({ "worktreeId": worktree_id })),
                Some(source.into()),
            ),
            WorktreeRefusal::RetireIncomplete { details, source } => (
                RefusalCode::WorktreeRetireIncomplete,
                refusal_fields(details),
                Some(source),
            ),
            WorktreeRefusal::ExecutionRootUnresolved {
                workspace_id,
                cause,
            } => {
                let detail = match cause_code_of(&cause) {
                    Some(cause_code) => json!({
                        "workspaceId": workspace_id,
                        "causeCode": cause_code.as_str(),
                    }),
                    None => json!({ "workspaceId": workspace_id }),
                };
                (
                    RefusalCode::WorkspaceExecutionRootUnresolved,
                    refusal_fields(detail),
                    Some(cause.into()),
                )
            }
            WorktreeRefusal::BranchNameRequired { workspace_id } => (
                RefusalCode::WorkspaceBranchNameRequired,
                refusal_fields(json!({ "workspaceId": workspace_id })),
                None,
            ),
        };
        DomainError {
            message,
            code,
            detail: Some(detail),
            source,
        }
    }
}

// The closed reason's message, except where the reason carries a line of its own.
fn create_failed_message(reason: &WorktreeCreateFailureReason) -> Cow<'_, str> {
    match reason {
        WorktreeCreateFailureReason::BaseRefOptionLike => Cow::Borrowed(
            "worktree creation failed: the supplied base ref begins with '-' and would be read as \
             a git option rather than as a commit-ish",
        ),
        WorktreeCreateFailureReason::BaseRefUnresolved => Cow::Borrowed(
            "worktree creation failed: no base ref was supplied and the repo mount's HEAD does \
             not resolve to a branch",
        ),
        WorktreeCreateFailureReason::BranchNameInvalid { git_line }
        | WorktreeCreateFailureReason::BranchNameTaken { git_line } => Cow::Borrowed(git_line),
        WorktreeCreateFailureReason::BranchNameUnderivable => Cow::Borrowed(
            "worktree creation failed: no branch name could be derived, since neither the \
             session's title nor a run id gave a tail",
        ),
        WorktreeCreateFailureReason::CarryBaseMismatch => Cow::Borrowed(
            "worktree creation refused: uncommitted work is carried only onto a tree cut from the \
             branch the session is on",
        ),
        WorktreeCreateFailureReason::CarryCheckoutRunning { .. } => Cow::Borrowed(
            "worktree creation refused: another session's run is live in the checkout the \
             uncommitted work would be carried from, and stashing it would take the work from \
             under that run",
        ),
        WorktreeCreateFailureReason::CarryFailed { recovery } => Cow::Owned(format!(
            "carrying the uncommitted work to the new worktree failed; the work is kept in a \
             stash, and {recovery}"
        )),
        WorktreeCreateFailureReason::ExecutionRootUnavailable => Cow::Borrowed(
            "worktree creation failed: the daemon's worktrees folder could not be prepared",
        ),
        WorktreeCreateFailureReason::GitInvocationFailed => {
            Cow::Borrowed("worktree creation failed: the git worktree invocation did not complete")
        }
        WorktreeCreateFailureReason::WorktreeFolderTaken => Cow::Borrowed(
            "worktree creation failed: the folder the worktree would be made in already exists",
        ),
    }
}

// The reason by its name, and for a run in the way, the session and agent running there.
fn create_failed_detail(reason: &WorktreeCreateFailureReason) -> Map<String, Value> {
    match reason {
        WorktreeCreateFailureReason::CarryCheckoutRunning {
            running_session_id,
            running_agent_id,
        } => refusal_fields(WorktreeCarryCheckoutRunningDetails {
            reason: CarryCheckoutRunningReason::Value,
            running_session_id: *running_session_id,
            running_agent_id: *running_agent_id,
        }),
        WorktreeCreateFailureReason::BaseRefOptionLike
        | WorktreeCreateFailureReason::BaseRefUnresolved
        | WorktreeCreateFailureReason::BranchNameInvalid { .. }
        | WorktreeCreateFailureReason::BranchNameTaken { .. }
        | WorktreeCreateFailureReason::BranchNameUnderivable
        | WorktreeCreateFailureReason::CarryBaseMismatch
        | WorktreeCreateFailureReason::CarryFailed { .. }
        | WorktreeCreateFailureReason::ExecutionRootUnavailable
        | WorktreeCreateFailureReason::GitInvocationFailed
        | WorktreeCreateFailureReason::WorktreeFolderTaken => {
            refusal_fields(json!({ "reason": <&'static str>::from(reason) }))
        }
    }
}

fn retire_conflict_message(details: &WorktreeRetireConflictDetails) -> String {
    match details {
        WorktreeRetireConflictDetails::RootBusy {
            worktree_id,
            running_session_id,
        } => format!(
            "worktree {worktree_id} cannot be removed: session {running_session_id} is \
             running in it"
        ),
        WorktreeRetireConflictDetails::HasChanges { worktree_id, .. } => format!(
            "worktree {worktree_id} cannot be removed without discarding: it holds uncommitted, \
             ignored or unpushed work"
        ),
    }
}

// The code of a cause that is itself a refusal; any other failure has none.
fn cause_code_of(cause: &RunSetupGateError) -> Option<RefusalCode> {
    match cause {
        RunSetupGateError::Refused(refusal) => Some(refusal.code),
        RunSetupGateError::Failed(_) => None,
    }
}

fn execution_root_unresolved_message(
    workspace_id: &WorkspaceId,
    cause: &RunSetupGateError,
) -> String {
    match cause_code_of(cause) {
        Some(cause_code) => format!(
            "workspace {} has no resolved execution root: root preparation failed with {} and the \
             run ended failed",
            workspace_id,
            cause_code.as_str()
        ),
        None => format!(
            "workspace {workspace_id} has no resolved execution root: root preparation failed and \
             the run ended failed"
        ),
    }
}
