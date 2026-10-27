//! The refusals of the project, repo mount and machine folder calls, each sent on the wire by its
//! code: the refusal's message becomes the reply's message and its detail `data.fields`.
//!
//! Each answers `-31000`, and a client tells them apart by `data.type`. Two messages are text the
//! daemon did not write: a clone refusal's git line and a failed clone service start's text, whose
//! paths the reply's sanitizing strips. Every other message names no path: a closed reason makes
//! that certain, the ones naming an id rely on ids being opaque, and the two naming a WSL
//! distribution carry its name alone. A root resolution's detail is the system's own reason for a
//! failed read, which names no path either.

use serde_json::json;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::free_form_string::FILE_PATH_MAX_LEN;
use sidekicks_contracts::jsonrpc::issue::{Issue, IssuePathSegment};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::place::{DistributionRefusalDetails, DistroName};
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::clone::ProjectCloneRefusedDetails;
use sidekicks_contracts::repo::folders::{
    ROOT_RESOLUTION_DETAIL_MAX_LEN, RepoMountAlreadyAttachedDetails,
    RepoMountOutsideTrustEnvelopeDetails, RepoMountOutsideTrustEnvelopeReason,
    RepoMountReattachConflictDetails, RepoMountReattachRefusedDetails,
    RepoMountReattachRefusedReason, RepoMountRootResolutionFailedDetails,
    RepoMountRootResolutionReason,
};
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use sidekicks_ipc::domain_error::{DomainError, refusal_fields};

/// Why a repository call was refused; nothing was written for any of them. Converts into the
/// [`DomainError`] the reply carries.
#[derive(Debug, thiserror::Error)]
pub enum RepoRefusal {
    /// The project record does not exist, or was forgotten (`project.notFound`).
    #[error("project {project_id} does not exist")]
    ProjectNotFound {
        /// The project asked for.
        project_id: ProjectId,
    },
    /// The repository mount does not exist (`repoMount.notFound`).
    #[error("repo mount {repo_mount_id} does not exist")]
    MountNotFound {
        /// The mount asked for.
        repo_mount_id: RepoMountId,
    },
    /// A path's canonical repository root could not be resolved, or a folder to list could not be
    /// read (`repoMount.rootResolutionFailed`); only the closed reason and the system's own words
    /// are kept, so the path tried never enters the refusal.
    #[error("{}", root_resolution_message(*.reason))]
    RootResolutionFailed {
        /// Why.
        reason: RepoMountRootResolutionReason,
        /// The system's own reason for a failed read, where there was one.
        detail: Option<FreeFormText<ROOT_RESOLUTION_DETAIL_MAX_LEN>>,
    },
    /// The path entered resolves to a root longer than the wire's path cap, so it is refused as
    /// the request's own path past the cap is (`request.paramsInvalid`), its issue at `localPath`
    /// naming the resolved length.
    #[error("the params break the method's contract")]
    ResolvedRootTooLong {
        /// The resolved root's length, in code points.
        code_points: usize,
    },
    /// A path or a workspace binding resolves outside the machine's attached roots, or names a
    /// tree whose removal is committed while its folder waits for deletion
    /// (`repoMount.outsideTrustEnvelope`); only the closed reason is kept, so no path can enter it.
    #[error(
        "workspace binding rejected: the resolved execution root is outside the declared local \
         trust envelope"
    )]
    OutsideTrustEnvelope {
        /// Why.
        reason: RepoMountOutsideTrustEnvelopeReason,
    },
    /// The folder's repository is already attached on this machine, by its canonical root or by
    /// its git common directory (`repoMount.alreadyAttached`); it names the holding mount, never
    /// the root.
    #[error(
        "repo attach refused: the folder's repository is already attached on this machine as \
         repo mount {}; bind a workspace on that mount to work in this folder",
        .conflicting_repo_mount_id
    )]
    AlreadyAttached {
        /// The mount that holds the repository.
        conflicting_repo_mount_id: RepoMountId,
        /// Its project, `None` for a chat's managed workspace.
        conflicting_project_id: Option<ProjectId>,
    },
    /// A detach while an agent runs anywhere in the project (`repoMount.detachConflict`).
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
    /// (`repoMount.managed`).
    #[error("repo mount {repo_mount_id} is a chat's managed workspace")]
    MountManaged {
        /// The managed mount.
        repo_mount_id: RepoMountId,
    },
    /// A re-attach of a mount that does not read `identityMismatch`, so there is nothing to
    /// recover (`repoMount.reattachRefused`).
    #[error(
        "repo mount {} still holds the repository attached there",
        .repo_mount_id
    )]
    ReattachRefused {
        /// The mount asked for; named in the message, not in the detail.
        repo_mount_id: RepoMountId,
    },
    /// A re-attach while an agent runs anywhere in the project (`repoMount.reattachConflict`).
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
    /// (`repoMount.distributionNeedsWsl2`); it names the distribution, never the path.
    #[error("{} runs on WSL 1", .distro.as_str())]
    DistributionNeedsWsl2 {
        /// The distribution.
        distro: DistroName,
    },
    /// No WSL distribution of the folder's name is on this computer
    /// (`repoMount.distributionNotFound`); it names the distribution, never the path.
    #[error("no WSL distribution named {} is on this computer", .distro.as_str())]
    DistributionNotFound {
        /// The distribution.
        distro: DistroName,
    },
    /// The top level was asked for on macOS or Linux, which has none
    /// (`machine.folder.topLevel.notOffered`).
    #[error("this computer has no top level above its folders")]
    TopLevelNotOffered,
    /// A clone refused before git starts and before anything is written (`project.clone.refused`):
    /// the destination holds something, or the address leaves no folder name, with git's line.
    #[error("{}", clone_refused_message(.details))]
    CloneRefused {
        /// Why, with git's own line where there is one.
        details: ProjectCloneRefusedDetails,
    },
    /// The clone service is not running, so no clone verb can run (`project.clone.unavailable`).
    #[error("{message}")]
    CloneUnavailable {
        /// The failed start's own text, or empty when the service was never started.
        message: String,
    },
}

/// The attach request's member holding the path entered, where a resolved root past the cap is
/// named.
const LOCAL_PATH_MEMBER: &str = "localPath";

impl From<RepoRefusal> for DomainError {
    fn from(refusal: RepoRefusal) -> Self {
        let message = refusal.to_string();
        let (code, detail) = match refusal {
            RepoRefusal::ProjectNotFound { project_id } => (
                RefusalCode::ProjectNotFound,
                Some(refusal_fields(json!({ "projectId": project_id }))),
            ),
            RepoRefusal::MountNotFound { repo_mount_id } => (
                RefusalCode::RepoMountNotFound,
                Some(refusal_fields(json!({ "repoMountId": repo_mount_id }))),
            ),
            RepoRefusal::RootResolutionFailed { reason, detail } => (
                RefusalCode::RepoMountRootResolutionFailed,
                Some(refusal_fields(RepoMountRootResolutionFailedDetails {
                    reason,
                    detail,
                })),
            ),
            RepoRefusal::ResolvedRootTooLong { code_points } => (
                RefusalCode::RequestParamsInvalid,
                Some(refusal_fields(json!({
                    "issues": [Issue {
                        path: vec![IssuePathSegment::Member(LOCAL_PATH_MEMBER.to_owned())],
                        message: format!(
                            "breaks the schema's \"maxLength\" rule once resolved: the root is \
                             {code_points} code points, past {FILE_PATH_MAX_LEN}"
                        ),
                        params: None,
                    }],
                }))),
            ),
            RepoRefusal::OutsideTrustEnvelope { reason } => (
                RefusalCode::RepoMountOutsideTrustEnvelope,
                Some(refusal_fields(RepoMountOutsideTrustEnvelopeDetails {
                    reason,
                })),
            ),
            RepoRefusal::AlreadyAttached {
                conflicting_repo_mount_id,
                conflicting_project_id,
            } => (
                RefusalCode::RepoMountAlreadyAttached,
                Some(refusal_fields(RepoMountAlreadyAttachedDetails {
                    conflicting_repo_mount_id,
                    conflicting_project_id,
                })),
            ),
            RepoRefusal::DetachConflict { running_session_id } => (
                RefusalCode::RepoMountDetachConflict,
                Some(refusal_fields(
                    json!({ "runningSessionId": running_session_id }),
                )),
            ),
            RepoRefusal::MountManaged { repo_mount_id } => (
                RefusalCode::RepoMountManaged,
                Some(refusal_fields(json!({ "repoMountId": repo_mount_id }))),
            ),
            RepoRefusal::ReattachRefused { repo_mount_id: _ } => (
                RefusalCode::RepoMountReattachRefused,
                Some(refusal_fields(RepoMountReattachRefusedDetails {
                    reason: RepoMountReattachRefusedReason::IdentityMatches,
                })),
            ),
            RepoRefusal::ReattachConflict {
                running_session_id,
                running_agent_id,
            } => (
                RefusalCode::RepoMountReattachConflict,
                Some(refusal_fields(RepoMountReattachConflictDetails {
                    running_session_id,
                    running_agent_id,
                })),
            ),
            RepoRefusal::DistributionNeedsWsl2 { distro } => (
                RefusalCode::RepoMountDistributionNeedsWsl2,
                Some(refusal_fields(DistributionRefusalDetails { distro })),
            ),
            RepoRefusal::DistributionNotFound { distro } => (
                RefusalCode::RepoMountDistributionNotFound,
                Some(refusal_fields(DistributionRefusalDetails { distro })),
            ),
            RepoRefusal::TopLevelNotOffered => (RefusalCode::MachineFolderTopLevelNotOffered, None),
            RepoRefusal::CloneRefused { details } => (
                RefusalCode::ProjectCloneRefused,
                Some(refusal_fields(details)),
            ),
            RepoRefusal::CloneUnavailable { message: _ } => {
                (RefusalCode::ProjectCloneUnavailable, None)
            }
        };
        DomainError {
            message,
            code,
            detail,
            source: None,
        }
    }
}

// The message of a `repoMount.rootResolutionFailed` refusal; none names the path tried.
fn root_resolution_message(reason: RepoMountRootResolutionReason) -> &'static str {
    match reason {
        RepoMountRootResolutionReason::NotAbsolute => {
            "canonical repository root resolution failed: the supplied path is not absolute"
        }
        RepoMountRootResolutionReason::PathNotFound => {
            "canonical repository root resolution failed: the supplied path does not exist"
        }
        RepoMountRootResolutionReason::NotReadable => {
            "canonical repository root resolution failed: the supplied path is not readable"
        }
        RepoMountRootResolutionReason::NotARepository => {
            "canonical repository root resolution failed: the supplied path is not a git \
             repository"
        }
        RepoMountRootResolutionReason::VcsError => {
            "canonical repository root resolution failed: the version-control root query did not \
             complete"
        }
        RepoMountRootResolutionReason::RootMismatch => {
            "canonical repository root resolution failed: the path's working tree is not one git \
             names for its repository, or the repository is not the one attached there"
        }
    }
}

// Git's own line where there is one; neither message names a path.
fn clone_refused_message(details: &ProjectCloneRefusedDetails) -> &str {
    match details {
        ProjectCloneRefusedDetails::NoDirectoryName { line } => line.as_str(),
        ProjectCloneRefusedDetails::DestinationNotEmpty {} => {
            "the clone's destination is already there and is not empty"
        }
    }
}
