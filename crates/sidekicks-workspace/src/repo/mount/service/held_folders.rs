//! The managed folders a chat holds, as its purge reads them, and the guarded statements that
//! release each: a holder's own hold while another chat holds the folder, or the mount with every
//! row on it once the last holder goes.

use std::borrow::Cow;

use rusqlite::{Connection, named_params};
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::text_column;

use super::managed_mount_deletion_statements;

// Another chat than `@session_id` holds the managed folder; a probe on the holds' key.
macro_rules! other_folder_hold {
    () => {
        "SELECT 1 FROM managed_folder_holds
          WHERE repo_mount_id = @repo_mount_id AND session_id <> @session_id LIMIT 1"
    };
}

// One row while another chat holds the managed folder, and one while none does.
const OTHER_FOLDER_HOLD_GUARD_SQL: &str =
    concat!("SELECT 1 WHERE EXISTS (", other_folder_hold!(), ")");
const NO_OTHER_FOLDER_HOLD_GUARD_SQL: &str =
    concat!("SELECT 1 WHERE NOT EXISTS (", other_folder_hold!(), ")");

const DELETE_FOLDER_HOLD_SQL: &str = "DELETE FROM managed_folder_holds
    WHERE repo_mount_id = @repo_mount_id AND session_id = @session_id";

// Each managed folder a chat holds: its mount, the chat it is made for, and whether another chat
// holds it too.
const SELECT_HELD_MANAGED_FOLDERS_SQL: &str = "SELECT hold.repo_mount_id,
          mount.managed_session_id,
          EXISTS (SELECT 1 FROM managed_folder_holds AS other
                   WHERE other.repo_mount_id = hold.repo_mount_id
                     AND other.session_id <> hold.session_id)
     FROM managed_folder_holds AS hold
     JOIN repo_mounts AS mount ON mount.id = hold.repo_mount_id
    WHERE hold.session_id = @session_id
    ORDER BY hold.repo_mount_id";

/// A managed folder a chat holds, as its purge reads it before removing any file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldManagedFolder {
    /// The folder's managed mount.
    pub repo_mount_id: RepoMountId,
    /// The chat the folder is made for, whose id names the folder; it may be gone.
    pub founding_session_id: SessionId,
    /// Whether another chat holds the folder too, so this chat's purge keeps it.
    pub is_held_by_another: bool,
}

/// Every managed folder `session_id` holds, read through its holds' session index with one probe
/// of the holds' key per folder. Fails as SQLite does, or when a stored id does not read as one.
pub fn read_held_managed_folders(
    connection: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<Vec<HeldManagedFolder>> {
    connection
        .prepare_cached(SELECT_HELD_MANAGED_FOLDERS_SQL)?
        .query_map(
            named_params! { "@session_id": session_id.text().as_str() },
            |row| {
                Ok(HeldManagedFolder {
                    repo_mount_id: text_column(row, 0, |text| RepoMountId::new(&text))?,
                    founding_session_id: text_column(row, 1, |text| SessionId::new(&text))?,
                    is_held_by_another: row.get(2)?,
                })
            },
        )?
        .collect()
}

/// The guard of what `session_id`'s purge decided for `folder`: one row while another chat holds
/// it, when the purge kept it, or while none does, when the purge removed it; a refusal means the
/// holders moved since the read, so the purge's write keeps every row.
pub fn held_managed_folder_guard(
    folder: &HeldManagedFolder,
    session_id: SessionId,
) -> WriteStatement {
    let sql = if folder.is_held_by_another {
        OTHER_FOLDER_HOLD_GUARD_SQL
    } else {
        NO_OTHER_FOLDER_HOLD_GUARD_SQL
    };
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(vec![
            text_binding("@repo_mount_id", folder.repo_mount_id.text().as_str()),
            text_binding("@session_id", session_id.text().as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// What `session_id`'s purge deletes of `folder` once its guard holds: its own hold while another
/// chat holds the folder, or the mount with every row on it when it was the last holder. The
/// chat's own workspace rows go with the rest of its rows.
pub fn held_managed_folder_release_statements(
    folder: &HeldManagedFolder,
    session_id: SessionId,
) -> Vec<WriteStatement> {
    if !folder.is_held_by_another {
        return managed_mount_deletion_statements(folder.repo_mount_id);
    }
    vec![WriteStatement {
        sql: Cow::Borrowed(DELETE_FOLDER_HOLD_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@repo_mount_id", folder.repo_mount_id.text().as_str()),
            text_binding("@session_id", session_id.text().as_str()),
        ]),
        expected_row_count: None,
    }]
}
