//! The first verdict a re-attach or a move owes each session on the mount it made. The commit's
//! write records the replaced mount on the new mount's row; every pass of the new mount sends its
//! verdict to each session on it whose log holds no health of the new mount, and clears the record
//! only after a pass whose every such send was appended, so a send that failed or that a stop cut
//! off is sent by the next pass, and a session that has it is never sent it again.
//!
//! A mount ended while it still owed its own first verdict keeps its record, since only a pass of
//! an attached mount clears one, so the records chain from the newest mount back through each one
//! it replaced. The verdict names, for each session, the nearest mount on that chain the session's
//! log holds health of, the one its banner was drawn for, and the direct one where it holds none;
//! the clear removes every record on the chain.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::repo::mount::{RepoMountId, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::text_column;

use super::{
    AttachedMount, MountHealthReadError, MountPassFailure, ProbeTimeoutReading,
    RepoMountHealthReprobe,
};

/// Where a mount's row records the mount a re-attach or a move replaced with it while its first
/// verdict is owed to a session on it.
pub(crate) const REPLACED_REPO_MOUNT_METADATA_PATH: &str = "$.replacedRepoMountId";

// The mounts `@repo_mount_id` replaced, nearest first, each row's record naming the one before it
// whatever its state; a record names a mount made before its own, so the chain ends.
static REPLACED_CHAIN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "WITH RECURSIVE replaced(repo_mount_id, depth) AS (
    SELECT json_extract(metadata, '{REPLACED_REPO_MOUNT_METADATA_PATH}'), 1
      FROM repo_mounts WHERE id = @repo_mount_id
    UNION ALL
    SELECT json_extract(mount.metadata, '{REPLACED_REPO_MOUNT_METADATA_PATH}'), replaced.depth + 1
      FROM replaced JOIN repo_mounts AS mount ON mount.id = replaced.repo_mount_id
  )"
    )
});

// The sessions with a live workspace on the mount whose log holds no health of it, each with the
// replaced mount its verdict names.
static SELECT_UNTOLD_SESSIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{}
SELECT untold.session_id, coalesce(
    (SELECT replaced.repo_mount_id FROM replaced
      WHERE EXISTS (
        SELECT 1 FROM session_events AS event
         WHERE event.session_id = untold.session_id AND event.type = '{health_changed}'
           AND json_extract(event.payload, '$.repoMountId') = replaced.repo_mount_id
      )
      ORDER BY replaced.depth
      LIMIT 1),
    (SELECT repo_mount_id FROM replaced WHERE depth = 1))
  FROM (
    SELECT DISTINCT workspace.session_id
      FROM workspaces AS workspace
     WHERE workspace.repo_mount_id = @repo_mount_id AND workspace.state <> '{archived}'
       AND NOT EXISTS (
         SELECT 1 FROM session_events AS event
          WHERE event.session_id = workspace.session_id AND event.type = '{health_changed}'
            AND json_extract(event.payload, '$.repoMountId') = @repo_mount_id
       )
  ) AS untold",
        *REPLACED_CHAIN_SQL,
        archived = <&'static str>::from(WorkspaceState::Archived),
        health_changed = SessionEventType::RepoMountHealthChanged.as_str()
    )
});

// The record of the mount and of every mount on its chain.
static CLEAR_REPLACED_REPO_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{}
UPDATE repo_mounts
    SET metadata = json_remove(metadata, '{REPLACED_REPO_MOUNT_METADATA_PATH}')
  WHERE id = @repo_mount_id OR id IN (SELECT repo_mount_id FROM replaced)",
        *REPLACED_CHAIN_SQL
    )
});

impl RepoMountHealthReprobe {
    /// Re-probes the one mount `repo_mount_id`, sending the first verdict it owes when a
    /// re-attach or a move just made it. Fails as one mount's pass fails, with
    /// [`MountPassFailure::FirstVerdictUnsent`] when the probe gave no verdict for a mount that
    /// owes one.
    pub(crate) async fn reprobe_mount(
        &self,
        repo_mount_id: RepoMountId,
    ) -> Result<(), Arc<MountPassFailure>> {
        self.request_pass(repo_mount_id, ProbeTimeoutReading::NoVerdict)
            .await
    }

    /// The sessions on `mount` still owed its first verdict, each with the replaced mount it names,
    /// read in one read only while one is owed. Fails as the read fails, and for a stored id the
    /// contracts refuse.
    pub(super) async fn read_owed_sessions(
        &self,
        mount: &AttachedMount,
    ) -> Result<HashMap<SessionId, RepoMountId>, MountHealthReadError> {
        if mount.replaced_repo_mount_id.is_none() {
            return Ok(HashMap::new());
        }
        let repo_mount_id = mount.id;
        self.reads
            .read(ReadLength::Short, move |connection| {
                read_untold_sessions(connection, repo_mount_id)
            })
            .await
    }

    /// What a pass of `mount` that reached no verdict answers: a failure while its first verdict is
    /// owed, unless the stop came; the record keeps it for the next pass either way.
    pub(super) fn answer_no_verdict(&self, mount: &AttachedMount) -> Result<(), MountPassFailure> {
        match mount.replaced_repo_mount_id {
            Some(_) if !self.stop.is_cancelled() => Err(MountPassFailure::FirstVerdictUnsent {
                repo_mount_id: mount.id,
            }),
            Some(_) | None => Ok(()),
        }
    }

    /// Clears the record of `mount`'s owed first verdict, and of each mount it replaced, once every
    /// session on it was told. Fails as the write fails, the records then kept.
    pub(super) async fn clear_first_verdict(
        &self,
        mount: &AttachedMount,
    ) -> Result<(), MountPassFailure> {
        if mount.replaced_repo_mount_id.is_none() {
            return Ok(());
        }
        let repo_mount_id = mount.id;
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(CLEAR_REPLACED_REPO_MOUNT_SQL.as_str()),
                bindings: StatementBindings::Named(vec![text_binding(
                    "@repo_mount_id",
                    repo_mount_id.text().as_str(),
                )]),
                expected_row_count: None,
            }])
            .await
            .map(drop)
            .map_err(|source| MountPassFailure::FirstVerdictUncleared {
                repo_mount_id,
                source,
            })
    }
}

fn read_untold_sessions(
    connection: &Connection,
    repo_mount_id: RepoMountId,
) -> Result<HashMap<SessionId, RepoMountId>, MountHealthReadError> {
    Ok(connection
        .prepare_cached(&SELECT_UNTOLD_SESSIONS_SQL)?
        .query_map(
            named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
            |row| {
                Ok((
                    text_column(row, 0, |text| SessionId::new(&text))?,
                    text_column(row, 1, |text| RepoMountId::new(&text))?,
                ))
            },
        )?
        .collect::<rusqlite::Result<_>>()?)
}
