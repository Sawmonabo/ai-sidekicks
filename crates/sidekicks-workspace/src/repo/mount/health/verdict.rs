//! The verdict a session on a mount heard: the root's health without its instant, and whether the
//! moved repository's captures were held, read back from the session's log for a session the
//! re-probe has not told yet.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::repo::mount::{CapturesHeld, RepoMountHealth, RepoMountId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::stored_column::{
    StoredJsonFault, optional_text_column, text_column,
};

use super::MountHealthReadError;

// The health and the captures held of the newest change a session's log holds for a mount, each as
// JSON text, the captures held `NULL` when the change says none.
static SELECT_LAST_LOGGED_HEALTH_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT payload -> '$.health', payload -> '$.capturesHeld'
   FROM session_events
  WHERE session_id = @session_id AND type = '{}'
    AND json_extract(payload, '$.repoMountId') = @repo_mount_id
  ORDER BY sequence DESC
  LIMIT 1",
        SessionEventType::RepoMountHealthChanged.as_str()
    )
});

/// The facts that make two health readings one verdict; the instant changes on every probe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct MountVerdict {
    /// The root's health.
    root: RootVerdict,
    /// What holds the moved repository's captures, while they are held.
    captures_held: Option<CapturesHeld>,
}

// The root's health without its instant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RootVerdict {
    Healthy,
    Unreachable,
    IdentityMismatch { is_repository: bool },
}

impl MountVerdict {
    /// What a session holds before anything was said to it.
    pub(super) const ASSUMED: Self = Self {
        root: RootVerdict::Healthy,
        captures_held: None,
    };

    /// The verdict of `health` with its captures held.
    pub(super) fn of(health: &RepoMountHealth, captures_held: Option<CapturesHeld>) -> Self {
        let root = match health {
            RepoMountHealth::Healthy { .. } => RootVerdict::Healthy,
            RepoMountHealth::Unreachable { .. } => RootVerdict::Unreachable,
            RepoMountHealth::IdentityMismatch { is_repository, .. } => {
                RootVerdict::IdentityMismatch {
                    is_repository: *is_repository,
                }
            }
        };
        Self {
            root,
            captures_held,
        }
    }

    /// Whether the root reads `healthy`, whatever holds its captures.
    pub(super) fn is_root_healthy(&self) -> bool {
        self.root == RootVerdict::Healthy
    }
}

/// The verdict each of `sessions` last read in its log for the mount, the assumed one where it
/// read none. Fails as the read or a stored payload does.
pub(super) fn read_logged_verdicts(
    connection: &Connection,
    repo_mount_id: RepoMountId,
    sessions: &[SessionId],
) -> Result<Vec<(SessionId, MountVerdict)>, MountHealthReadError> {
    let mut statement = connection.prepare_cached(&SELECT_LAST_LOGGED_HEALTH_SQL)?;
    let repo_mount_id = repo_mount_id.text();
    sessions
        .iter()
        .map(|session_id| {
            let logged = statement
                .query_row(
                    named_params! {
                        "@session_id": session_id.text().as_str(),
                        "@repo_mount_id": repo_mount_id.as_str(),
                    },
                    |row| {
                        let health = text_column(row, 0, |text| {
                            serde_json::from_str::<RepoMountHealth>(&text)
                                .map_err(StoredJsonFault::from)
                        })?;
                        let captures_held = optional_text_column(row, 1, |text| {
                            serde_json::from_str::<CapturesHeld>(&text)
                                .map_err(StoredJsonFault::from)
                        })?;
                        Ok(MountVerdict::of(&health, captures_held))
                    },
                )
                .optional()?;
            Ok((*session_id, logged.unwrap_or(MountVerdict::ASSUMED)))
        })
        .collect()
}
