//! A session's artifact list: every plan the agent finished, with the state word its plan record
//! holds, and every file and folder a chat wrote, listed once with its newest version and how many
//! versions it has. Any other artifact (an attachment, a client's log or diff) is no entry.
//!
//! A chat's files are those of the chat folder it holds, whichever holding chat wrote them, so
//! every holder lists the same versions; each version's manifest names the chat that recorded it.
//!
//! A hand-off's seed plan, written again in the fresh session, lists there as accepted, from the
//! fresh session's hand-off row once the planning session's purge has deleted the plan row. A plan
//! manifest with neither row is no entry, since an entry needs its title. A fresh session whose
//! hand-off ended before its first turn keeps its seed manifest, which lists the plan's own word.

use std::sync::LazyLock;

use rusqlite::{Connection, named_params};
use sidekicks_contracts::artifacts::operations::{ArtifactListEntry, ArtifactListResponse};
use sidekicks_contracts::plan::{PlanId, PlanState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::ComposedText;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_session::directory::lookups::session_exists;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::stored_column::{closed_word, safe_int_column, text_column};

use crate::manifest_write::{MANIFEST_COLUMN_COUNT, MANIFEST_COLUMNS, read_manifest};
use crate::refusals::ArtifactError;

// The session's plans, oldest first, each with the word its record holds, or accepted where this
// session is the one the plan was handed off to. A seed plan whose plan row is gone takes its title
// from this session's hand-off row and lists accepted; a plan manifest with neither row is left
// out, since an entry's title is required.
static PLAN_ENTRIES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {MANIFEST_COLUMNS}, manifests.plan_id, COALESCE(plans.title, hand_off.title),
       CASE WHEN plans.id IS NULL OR plans.fresh_session_id = manifests.session_id
            THEN '{accepted}' ELSE plans.state END
  FROM artifact_manifests AS manifests
  LEFT JOIN plans ON plans.id = manifests.plan_id
  LEFT JOIN session_hand_offs AS hand_off
    ON hand_off.session_id = manifests.session_id AND hand_off.plan_id = manifests.plan_id
  WHERE manifests.session_id = @sessionId AND manifests.plan_id IS NOT NULL
    AND (plans.id IS NOT NULL OR hand_off.session_id IS NOT NULL)
  ORDER BY manifests.created_at, manifests.id",
        accepted = <&'static str>::from(PlanState::Accepted)
    )
});

// The newest version of each path of the chat folders the session holds, oldest path first, with
// the chat that recorded it; the newest version's number is how many versions the path has.
static FILE_ENTRIES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {MANIFEST_COLUMNS}, manifests.workspace_path, manifests.version_number,
       manifests.session_id
  FROM managed_folder_holds AS hold
  JOIN artifact_manifests AS manifests
    ON manifests.repo_mount_id = hold.repo_mount_id AND manifests.workspace_path IS NOT NULL
  WHERE hold.session_id = @sessionId
    AND manifests.version_number = (SELECT MAX(newer.version_number)
                                      FROM artifact_manifests AS newer
                                     WHERE newer.repo_mount_id = manifests.repo_mount_id
                                       AND newer.workspace_path = manifests.workspace_path)
  ORDER BY manifests.workspace_path, manifests.repo_mount_id"
    )
});

/// The artifacts of `session_id`: its plans, then the files and folders of its chat folder. Fails
/// with `session.notFound` for a session the daemon does not hold, and as the read fails.
pub async fn list_artifacts(
    reads: &DatabaseReadPool,
    session_id: SessionId,
) -> Result<ArtifactListResponse, ArtifactError> {
    reads
        .read(ReadLength::Short, move |connection| {
            if !session_exists(connection, &session_id)? {
                return Err(session_not_found(&session_id).into());
            }
            Ok(ArtifactListResponse {
                artifacts: read_list_entries(connection, session_id)?,
            })
        })
        .await
}

// The plan arms, then the file arms, of `session_id`.
fn read_list_entries(
    connection: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<Vec<ArtifactListEntry>> {
    let mut entries: Vec<ArtifactListEntry> = connection
        .prepare_cached(&PLAN_ENTRIES_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            |row| {
                Ok(ArtifactListEntry::Plan {
                    manifest: read_manifest(row, session_id)?,
                    plan_id: text_column(row, MANIFEST_COLUMN_COUNT, |text| PlanId::new(&text))?,
                    title: row.get(MANIFEST_COLUMN_COUNT + 1)?,
                    state: text_column(row, MANIFEST_COLUMN_COUNT + 2, closed_word)?,
                })
            },
        )?
        .collect::<rusqlite::Result<_>>()?;
    let mut files = connection.prepare_cached(&FILE_ENTRIES_SQL)?;
    let files = files.query_map(
        named_params! { "@sessionId": session_id.text().as_str() },
        |row| {
            let recorded_on =
                text_column(row, MANIFEST_COLUMN_COUNT + 2, |text| SessionId::new(&text))?;
            Ok(ArtifactListEntry::File {
                manifest: read_manifest(row, recorded_on)?,
                path: text_column(row, MANIFEST_COLUMN_COUNT, |text| {
                    ComposedText::new(text).ok_or(StoredPathEmptyError)
                })?,
                version_count: safe_int_column(row, MANIFEST_COLUMN_COUNT + 1)?,
            })
        },
    )?;
    for file in files {
        entries.push(file?);
    }
    Ok(entries)
}

/// A stored workspace path that is empty, which no write stores.
#[derive(Debug, thiserror::Error)]
#[error("the stored workspace path is empty")]
struct StoredPathEmptyError;
