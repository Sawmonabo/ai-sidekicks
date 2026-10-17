//! The `repo.*` refusals, each sent on the wire by its code: the refusal's message becomes the
//! reply's message and its detail `data.fields`.
//!
//! Only the two `repo.not_found` refusals, a mount's and a project's, answer `-32602`, as a missing
//! session does; the others answer `-32603` and a client tells them apart by `data.type`. Two
//! messages are text the daemon did not write: a clone refusal's git line and a failed clone
//! service start's text, whose paths the reply's sanitizing strips. Every other message names no
//! path: a closed reason makes that certain, the ones naming an id rely on ids being opaque, and
//! the two naming a WSL distribution carry its name alone.

use serde_json::json;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::place::DistroName;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::clone::RepoCloneRefusedDetails;
use sidekicks_contracts::repo::folders::{
    RepoAlreadyAttachedDetails, RepoDistributionRefusalDetails, RepoOutsideTrustEnvelopeDetails,
    RepoOutsideTrustEnvelopeReason, RepoReattachConflictDetails, RepoReattachRefusedDetails,
    RepoReattachRefusedReason, RepoRootResolutionFailedDetails, RepoRootResolutionReason,
};
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;

use crate::ipc::domain_error::{DomainError, DomainErrorJsonRpcCode, refusal_fields};

/// Why a repository call was refused; nothing was written for any of them. Converts into the
/// [`DomainError`] the reply carries.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RepoRefusal {
    /// The project record does not exist, or was forgotten (`repo.not_found`).
    #[error("project {project_id} does not exist")]
    ProjectNotFound {
        /// The project asked for.
        project_id: ProjectId,
    },
    /// The repository mount does not exist (`repo.not_found`).
    #[error("repo mount {repo_mount_id} does not exist")]
    MountNotFound {
        /// The mount asked for.
        repo_mount_id: RepoMountId,
    },
    /// A path's canonical repository root could not be resolved (`repo.root_resolution_failed`);
    /// only the closed reason is kept, so the path tried never enters the refusal.
    #[error("{}", root_resolution_message(*.reason))]
    RootResolutionFailed {
        /// Why.
        reason: RepoRootResolutionReason,
    },
    /// A path or a workspace binding resolves outside the machine's attached roots, or names a
    /// tree whose removal is committed while its folder waits for deletion
    /// (`repo.outside_trust_envelope`); only the closed reason is kept, so no path can enter it.
    #[error(
        "workspace binding rejected: the resolved execution root is outside the declared local \
         trust envelope"
    )]
    OutsideTrustEnvelope {
        /// Why.
        reason: RepoOutsideTrustEnvelopeReason,
    },
    /// The folder's repository is already attached on this node, by its canonical root or by its
    /// git common directory (`repo.already_attached`); it names the holding mount, never the root.
    #[error(
        "repo attach refused: the folder's repository is already attached on this node as repo \
         mount {}; bind a workspace on that mount to work in this folder",
        .conflicting_repo_mount_id
    )]
    AlreadyAttached {
        /// The mount that holds the repository.
        conflicting_repo_mount_id: RepoMountId,
        /// Its project, `None` for a chat's managed workspace.
        conflicting_project_id: Option<ProjectId>,
    },
    /// A detach while an agent runs anywhere in the project (`repo.detach_conflict`).
    #[error(
        "repo detach refused: session {} is running in the project",
        .running_session_id
    )]
    DetachConflict {
        /// The session running there, so the refusal can say who holds the folder.
        running_session_id: SessionId,
    },
    /// The mount is a chat's managed workspace, which only that chat binds and only its purge
    /// removes, so another session's bind, any detach and a move of the chat are refused
    /// (`repo.mount_managed`).
    #[error("repo mount {repo_mount_id} is a chat's managed workspace")]
    MountManaged {
        /// The managed mount.
        repo_mount_id: RepoMountId,
    },
    /// A re-attach of a mount that does not read `identity_mismatch`, so there is nothing to
    /// recover (`repo.reattach_refused`).
    #[error(
        "repo mount {} still holds the repository attached there",
        .repo_mount_id
    )]
    ReattachRefused {
        /// The mount asked for; named in the message, not in the detail.
        repo_mount_id: RepoMountId,
    },
    /// A re-attach while an agent runs anywhere in the project (`repo.reattach_conflict`).
    #[error(
        "repo re-attach refused: agent {} is running in session {}",
        .running_agent_id,
        .running_session_id
    )]
    ReattachConflict {
        /// The session the agent runs in.
        running_session_id: SessionId,
        /// The agent running.
        running_agent_id: AgentId,
    },
    /// The folder's WSL distribution runs on WSL 1, where no session runs
    /// (`repo.distribution_needs_wsl2`); it names the distribution, never the path.
    #[error("{} runs on WSL 1", .distro.as_str())]
    DistributionNeedsWsl2 {
        /// The distribution.
        distro: DistroName,
    },
    /// No WSL distribution of the folder's name is on this computer
    /// (`repo.distribution_not_found`); it names the distribution, never the path.
    #[error("no WSL distribution named {} is on this computer", .distro.as_str())]
    DistributionNotFound {
        /// The distribution.
        distro: DistroName,
    },
    /// The top level was asked for on macOS or Linux, which has none
    /// (`repo.top_level_unavailable`).
    #[error("this computer has no top level above its folders")]
    TopLevelUnavailable,
    /// A clone refused before git starts and before anything is written (`repo.clone_refused`):
    /// the destination holds something, or the address leaves no folder name, with git's line.
    #[error("{}", clone_refused_message(.details))]
    CloneRefused {
        /// Why, with git's own line where there is one.
        details: RepoCloneRefusedDetails,
    },
    /// The clone service is not running, so no clone verb can run (`repo.clone_unavailable`).
    #[error("{message}")]
    CloneUnavailable {
        /// The failed start's own text, or empty when the service was never started.
        message: String,
    },
}

impl From<RepoRefusal> for DomainError {
    fn from(refusal: RepoRefusal) -> Self {
        use DomainErrorJsonRpcCode::{InternalError, InvalidParams};

        let message = refusal.to_string();
        // An id the call supplies that resolves to nothing is a bad parameter, as a missing
        // session is; every other refusal answers as an internal error.
        let (code, json_rpc_code, detail) = match refusal {
            RepoRefusal::ProjectNotFound { project_id } => (
                RefusalCode::RepoNotFound,
                InvalidParams,
                Some(refusal_fields(json!({ "projectId": project_id }))),
            ),
            RepoRefusal::MountNotFound { repo_mount_id } => (
                RefusalCode::RepoNotFound,
                InvalidParams,
                Some(refusal_fields(json!({ "repoMountId": repo_mount_id }))),
            ),
            RepoRefusal::RootResolutionFailed { reason } => (
                RefusalCode::RepoRootResolutionFailed,
                InternalError,
                Some(refusal_fields(RepoRootResolutionFailedDetails { reason })),
            ),
            RepoRefusal::OutsideTrustEnvelope { reason } => (
                RefusalCode::RepoOutsideTrustEnvelope,
                InternalError,
                Some(refusal_fields(RepoOutsideTrustEnvelopeDetails { reason })),
            ),
            RepoRefusal::AlreadyAttached {
                conflicting_repo_mount_id,
                conflicting_project_id,
            } => (
                RefusalCode::RepoAlreadyAttached,
                InternalError,
                Some(refusal_fields(RepoAlreadyAttachedDetails {
                    conflicting_repo_mount_id,
                    conflicting_project_id,
                })),
            ),
            RepoRefusal::DetachConflict { running_session_id } => (
                RefusalCode::RepoDetachConflict,
                InternalError,
                Some(refusal_fields(
                    json!({ "runningSessionId": running_session_id }),
                )),
            ),
            RepoRefusal::MountManaged { repo_mount_id } => (
                RefusalCode::RepoMountManaged,
                InternalError,
                Some(refusal_fields(json!({ "repoMountId": repo_mount_id }))),
            ),
            RepoRefusal::ReattachRefused { repo_mount_id: _ } => (
                RefusalCode::RepoReattachRefused,
                InternalError,
                Some(refusal_fields(RepoReattachRefusedDetails {
                    reason: RepoReattachRefusedReason::IdentityMatches,
                })),
            ),
            RepoRefusal::ReattachConflict {
                running_session_id,
                running_agent_id,
            } => (
                RefusalCode::RepoReattachConflict,
                InternalError,
                Some(refusal_fields(RepoReattachConflictDetails {
                    running_session_id,
                    running_agent_id,
                })),
            ),
            RepoRefusal::DistributionNeedsWsl2 { distro } => (
                RefusalCode::RepoDistributionNeedsWsl2,
                InternalError,
                Some(refusal_fields(RepoDistributionRefusalDetails { distro })),
            ),
            RepoRefusal::DistributionNotFound { distro } => (
                RefusalCode::RepoDistributionNotFound,
                InternalError,
                Some(refusal_fields(RepoDistributionRefusalDetails { distro })),
            ),
            RepoRefusal::TopLevelUnavailable => {
                (RefusalCode::RepoTopLevelUnavailable, InternalError, None)
            }
            RepoRefusal::CloneRefused { details } => (
                RefusalCode::RepoCloneRefused,
                InternalError,
                Some(refusal_fields(details)),
            ),
            RepoRefusal::CloneUnavailable { message: _ } => {
                (RefusalCode::RepoCloneUnavailable, InternalError, None)
            }
        };
        DomainError {
            message,
            code,
            json_rpc_code,
            detail,
            source: None,
        }
    }
}

// The message of a `repo.root_resolution_failed` refusal; none names the path tried.
fn root_resolution_message(reason: RepoRootResolutionReason) -> &'static str {
    match reason {
        RepoRootResolutionReason::NotAbsolute => {
            "canonical repository root resolution failed: the supplied path is not absolute"
        }
        RepoRootResolutionReason::PathNotFound => {
            "canonical repository root resolution failed: the supplied path does not exist"
        }
        RepoRootResolutionReason::NotReadable => {
            "canonical repository root resolution failed: the supplied path is not readable"
        }
        RepoRootResolutionReason::NotARepository => {
            "canonical repository root resolution failed: the supplied path is not a git \
             repository"
        }
        RepoRootResolutionReason::VcsError => {
            "canonical repository root resolution failed: the version-control root query did not \
             complete"
        }
        RepoRootResolutionReason::RootMismatch => {
            "canonical repository root resolution failed: the path's working tree is not one git \
             names for its repository, or the repository is not the one attached there"
        }
    }
}

// Git's own line where there is one; neither message names a path.
fn clone_refused_message(details: &RepoCloneRefusedDetails) -> &str {
    match details {
        RepoCloneRefusedDetails::NoDirectoryName { line } => line.as_str(),
        RepoCloneRefusedDetails::DestinationNotEmpty {} => {
            "the clone's destination is already there and is not empty"
        }
    }
}
