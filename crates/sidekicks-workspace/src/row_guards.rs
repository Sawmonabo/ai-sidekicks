//! The keys the workspace and repository mount services keep in their rows' `metadata`, the probe
//! of a root's reachability, and the checks those services run against their rows: a root that
//! names one complete location, the one mode rule of a chat's managed mount, a write that expects
//! to change one row, and the stored `lastError` read back.

use std::error::Error;
use std::path::Path;

use serde_json::Value;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceId};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::PathRules;
use sidekicks_std::file::bounded_read::read_within_ceiling;
use sidekicks_store::database::stored_column::{StoredJsonFault, parse_stored_json_object};
use sidekicks_store::events::log_service::EventAppendError;
use sidekicks_store::events::session::appender::{SessionEventAppendError, SessionEventEmitError};

use crate::errors::{
    WorkspaceRefusal, WorkspaceServiceInvariantError, WorkspaceServiceInvariantKind,
};
use crate::projector::FilesystemPathProbe;
use crate::service::WorkspaceServiceError;

/// The JSON path in `repo_mounts.metadata` of the mount's identity anchor: the git common folder,
/// each link resolved, that its attach recorded.
pub(crate) const COMMON_DIR_METADATA_PATH: &str = "$.commonDir";

/// The JSON path in `workspaces.metadata` of why a `rootLost` workspace's last preparation failed,
/// the one metadata key that reaches the wire.
pub(crate) const LAST_ERROR_METADATA_PATH: &str = "$.lastError";

/// The JSON path in `workspaces.metadata` of the folder the bind admitted, where a `boundRoot` run
/// works. The bind writes it and nothing clears it.
pub const BOUND_ROOT_METADATA_PATH: &str = "$.boundRoot";

/// The JSON path in `workspaces.metadata` of the top level of the working tree the workspace works
/// in now: the bound checkout's, or its worktree's once one is its execution root.
pub const CHECKOUT_ROOT_METADATA_PATH: &str = "$.checkoutRoot";

// The member name under the path's `$.`, so the key and its path are one fact.
const LAST_ERROR_METADATA_KEY: &str = LAST_ERROR_METADATA_PATH.split_at(2).1;

/// Whether `path` can be reached in `place` now, read on this computer: the folder opens for
/// listing, as running there needs, within the bounded read's ceiling, so a hung network folder
/// reads as unreachable. The instant is read first, so it is never newer than the observation it
/// stamps. The probe names `path` exactly as given, since the projector refuses a probe of any
/// other spelling.
pub(crate) async fn probe_filesystem_path(
    path: &Path,
    place: Option<&Place>,
) -> FilesystemPathProbe {
    let checked_at = WireInstant::now();
    let is_reachable =
        match read_within_ceiling(path, |path| std::fs::read_dir(path).map(drop)).await {
            Ok(()) => true,
            // The failure is the verdict; its cause stays in the log for whoever looks into it.
            Err(error) => {
                tracing::debug!(
                    error = &error as &(dyn Error + 'static),
                    "a probed root could not be opened"
                );
                false
            }
        };
    FilesystemPathProbe {
        probed_path: path.to_path_buf(),
        probed_place: place.cloned(),
        is_reachable,
        checked_at,
    }
}

/// Refuses an execution root that would need the daemon's own state to become concrete: a
/// relative path, `~`, or a Windows root with no drive (`\repos\app`). Fails with
/// [`WorkspaceServiceInvariantKind::NonAbsoluteExecutionRoot`], whose message does not echo the
/// candidate.
pub(crate) fn assert_absolute_execution_root(
    candidate: &Path,
    workspace_id: WorkspaceId,
) -> Result<(), WorkspaceServiceInvariantError> {
    if PathRules::NATIVE.names_complete_location(&candidate.to_string_lossy()) {
        return Ok(());
    }
    Err(WorkspaceServiceInvariantError {
        message: "execution root does not name one complete location; the daemon would have to \
                  supply the missing piece from its own state"
            .to_owned(),
        kind: WorkspaceServiceInvariantKind::NonAbsoluteExecutionRoot,
        workspace_id: Some(workspace_id),
        source: None,
    })
}

/// Refuses a worktree on a chat's managed mount, the one mode rule: a chat works only in its own
/// folder. Fails with [`WorkspaceRefusal::ModeUnsupported`].
pub(crate) fn assert_mode_offered(
    execution_mode: ExecutionMode,
    is_managed_mount: bool,
) -> Result<(), WorkspaceRefusal> {
    match execution_mode {
        ExecutionMode::ProvisionedWorktree if is_managed_mount => {
            Err(WorkspaceRefusal::ModeUnsupported { execution_mode })
        }
        ExecutionMode::ProvisionedWorktree | ExecutionMode::BoundRoot => Ok(()),
    }
}

/// `appended`, an event append whose prelude's guarded statement expects one row, with a refusal of
/// that statement read as the row having moved: [`WorkspaceServiceError::Invariant`] of kind
/// [`WorkspaceServiceInvariantKind::IllegalStateTransition`], naming `moved_subject` (the row
/// that failed the guard, such as the repo mount for a bind's conditional insert) and keeping the
/// refusal as its cause. Any other failure passes through as [`WorkspaceServiceError::Append`].
pub(crate) fn expect_single_row_changed<Appended>(
    appended: Result<Appended, SessionEventEmitError>,
    workspace_id: WorkspaceId,
    attempted_action: &str,
    moved_subject: &str,
) -> Result<Appended, WorkspaceServiceError> {
    match appended {
        Ok(appended) => Ok(appended),
        Err(error) if refused_append_index(&error).is_some() => {
            Err(WorkspaceServiceInvariantError {
                message: format!(
                    "cannot {attempted_action} workspace \"{workspace_id}\": {moved_subject} left \
                     its expected state before the write committed"
                ),
                kind: WorkspaceServiceInvariantKind::IllegalStateTransition,
                workspace_id: Some(workspace_id),
                source: Some(Box::new(error)),
            }
            .into())
        }
        Err(error) => Err(WorkspaceServiceError::Append(error)),
    }
}

/// The position in an append's write of the statement whose row count refused it, `None` for any
/// other failure.
pub(crate) fn refused_append_index(error: &SessionEventEmitError) -> Option<usize> {
    match error {
        SessionEventEmitError::Append(SessionEventAppendError::Append(
            EventAppendError::Write(write),
        )) => write.refused_statement_index(),
        SessionEventEmitError::Draft(_) | SessionEventEmitError::Append(_) => None,
    }
}

/// The `lastError` a workspace row's `metadata` holds, `None` when it holds none or a value that
/// is not text. Fails with [`StoredJsonFault`] when the blob is no JSON object: only SQLite's JSON
/// functions write it, so that is a corrupt row.
pub(crate) fn read_last_error(metadata: &str) -> Result<Option<String>, StoredJsonFault> {
    let members = parse_stored_json_object(metadata)?;
    Ok(members
        .get(LAST_ERROR_METADATA_KEY)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned))
}
