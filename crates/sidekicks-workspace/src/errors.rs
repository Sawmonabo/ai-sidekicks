//! The workspace service's refusals, each sent on the wire by its `workspace.*` code, and its
//! internal failure, which has no code. No message embeds a path or a credential.

use std::error::Error;

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceId};
use sidekicks_ipc::domain_error::DomainError;

/// Why the workspace service refused a call; the execution-root service's `workspace.*` codes are
/// not among them. Converts into the [`DomainError`] the reply carries.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkspaceRefusal {
    /// The named workspace does not exist (`workspace.notFound`).
    #[error("workspace {workspace_id} does not exist")]
    NotFound {
        /// The workspace asked for.
        workspace_id: WorkspaceId,
    },
    /// A worktree was asked of a chat's managed workspace, which offers only its own root
    /// (`workspace.modeUnsupported`).
    #[error(
        "execution mode {} is unavailable on this repo mount: a chat's managed workspace offers \
         only its own root",
        <&'static str>::from(*.execution_mode)
    )]
    ModeUnsupported {
        /// The refused mode.
        execution_mode: ExecutionMode,
    },
    /// The execution root is gone, or its mount's folder is unreachable or holds another repository
    /// now (`workspace.rootUnavailable`). No path is named, since a refusal can reach a remote
    /// caller.
    #[error("{}", root_unavailable_message(.workspace_id.as_ref()))]
    RootUnavailable {
        /// The workspace whose root is lost, or `None` for a bind refused before its workspace
        /// exists because the mount's root is unreachable.
        workspace_id: Option<WorkspaceId>,
    },
}

impl From<WorkspaceRefusal> for DomainError {
    fn from(refusal: WorkspaceRefusal) -> Self {
        let message = refusal.to_string();
        let (code, detail) = match refusal {
            WorkspaceRefusal::NotFound { workspace_id } => (
                RefusalCode::WorkspaceNotFound,
                json!({ "workspaceId": workspace_id }),
            ),
            WorkspaceRefusal::ModeUnsupported { execution_mode } => (
                RefusalCode::WorkspaceModeUnsupported,
                json!({ "executionMode": <&'static str>::from(execution_mode) }),
            ),
            WorkspaceRefusal::RootUnavailable { workspace_id } => (
                RefusalCode::WorkspaceRootUnavailable,
                // A refused bind names no workspace, so its detail is empty.
                workspace_id.map_or_else(
                    || json!({}),
                    |workspace_id| json!({ "workspaceId": workspace_id }),
                ),
            ),
        };
        DomainError::new(message, code).with_detail(detail)
    }
}

fn root_unavailable_message(workspace_id: Option<&WorkspaceId>) -> String {
    match workspace_id {
        Some(workspace_id) => {
            format!(
                "workspace {workspace_id} lost its working root: new runs are blocked until it is \
                 repaired"
            )
        }
        None => "workspace binding refused: the repo mount's execution root is no longer reachable"
            .to_owned(),
    }
}

/// What a [`WorkspaceServiceInvariantError`] reports broke; the kinds differ only in what a person
/// should inspect, and nothing branches on them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceServiceInvariantKind {
    /// A stored row cannot be projected onto the wire shape: a state or an id the contracts
    /// refuse, a missing `fs_root` under a state that owes a probe, or a probe of another path. A
    /// probe of another path is a bug in the projection's caller; the rest is corrupt data.
    WorkspaceRowUnprojectable,
    /// The on-read check derived a `rootLost` transition it could not make durable (a locked
    /// database, a full disk, a size refusal); the row is fine and the write path is the defect.
    RootLostTransitionDurabilityFailure,
    /// A daemon caller asked for a transition the workspace lifecycle does not admit.
    IllegalStateTransition,
    /// A caller offered an execution root that is not one complete location; completing it would
    /// widen what the approval covers.
    NonAbsoluteExecutionRoot,
    /// A run's root has no branch recorded, so its run context cannot be written.
    BranchContextMissing,
}

/// A failure inside the workspace service that has no wire code, so it is no [`DomainError`]:
/// borrowing a code would misreport the cause. It reaches the socket as an anonymous `-32603`.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct WorkspaceServiceInvariantError {
    /// What broke, in words a person reads; it names no path.
    pub(crate) message: String,
    /// Which kind of failure it is.
    pub(crate) kind: WorkspaceServiceInvariantKind,
    /// The workspace the failure attaches to, or `None` when no row is implicated.
    pub(crate) workspace_id: Option<WorkspaceId>,
    /// The failure underneath, when one caused it.
    #[source]
    pub(crate) source: Option<Box<dyn Error + Send + Sync>>,
}
