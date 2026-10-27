//! Damage to the database file found while the daemon has it open: the start's check, or any read
//! or write SQLite failed as corrupt. The file cannot be replaced under open connections, so the
//! damage is recorded beside the file, the daemon stops, and its next start repairs the file from
//! the record, before anything opens it.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};

use rusqlite::ErrorCode;
use tokio::sync::{SetOnce, SetOnceError};

use crate::database::sibling_path;
use crate::database::writer::sqlite_error_code;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::file::atomic_write::{AtomicWriteError, write_file_atomically};
use sidekicks_std::missing_entry::MissingEntry as _;

/// The suffix of the damage record kept beside the database file.
const DAMAGE_RECORD_SUFFIX: &str = ".damaged";

/// The damage record's mode: only the user reads it.
const DAMAGE_RECORD_MODE: u32 = 0o600;

/// Whether SQLite failed because the file is damaged: any `SQLITE_CORRUPT` code, an index's
/// included, which a write can raise too, or a file that is not a database, carried by `error` or
/// the first of its sources to carry a SQLite code.
pub(crate) fn is_database_damage_error(error: &(dyn Error + 'static)) -> bool {
    matches!(
        sqlite_error_code(error),
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

/// Learns of damage to the database file once, from whichever part of the daemon meets it.
pub(crate) struct DatabaseDamageWatch {
    found: SetOnce<String>,
}

impl DatabaseDamageWatch {
    /// A watch that has found no damage.
    pub(crate) fn new() -> Self {
        Self {
            found: SetOnce::new(),
        }
    }

    /// Resolves with what the first damage found was; never resolves while none is.
    pub(crate) async fn when_found(&self) -> &str {
        self.found.wait().await
    }

    /// What the first damage found was, `None` while none is.
    pub(crate) fn found(&self) -> Option<&str> {
        self.found.get().map(String::as_str)
    }

    /// Whether damage has been found, so a caller acts before a waiter on `when_found` runs.
    pub(crate) fn is_found(&self) -> bool {
        self.found.initialized()
    }

    /// Records damage the check or a caller describes as `damage`; only the first counts.
    pub(crate) fn find(&self, damage: String) {
        if let Err(SetOnceError(later)) = self.found.set(damage) {
            // Two parts of the daemon can meet the damage at once; the first find is the one the
            // repair reads, so a later one is dropped.
            drop(later);
        }
    }

    /// Records `error` as damage when SQLite raised it for a damaged file; any other failure is
    /// left to its caller. The start, the recovery pass and every read that meets a failure call
    /// it; nothing is built for a failure that is no damage, or once damage is found.
    pub(crate) fn report(&self, error: &(dyn Error + 'static)) {
        if !self.is_found() && is_database_damage_error(error) {
            self.find(describe_error(error));
        }
    }
}

/// Records the damage beside the database file, durably, so the next start repairs the file.
/// Fails with the crash-safe write's failure.
pub(crate) async fn record_database_damage(
    database_path: &Path,
    damage: &str,
) -> Result<(), AtomicWriteError> {
    write_file_atomically(
        &damage_record_path(database_path),
        damage.to_owned(),
        DAMAGE_RECORD_MODE,
    )
    .await
}

/// The damage a run recorded for the next start to repair, `None` when none was. Fails with the
/// file system's error.
pub(crate) async fn read_database_damage(database_path: &Path) -> io::Result<Option<String>> {
    tokio::fs::read_to_string(damage_record_path(database_path))
        .await
        .none_if_missing()
}

/// Removes the damage record once the file it named is replaced or gone; a missing record is
/// already removed. Fails with the file system's error.
pub(crate) async fn remove_database_damage(database_path: &Path) -> io::Result<()> {
    tokio::fs::remove_file(damage_record_path(database_path))
        .await
        .none_if_missing()
        .map(drop)
}

fn damage_record_path(database_path: &Path) -> PathBuf {
    sibling_path(database_path, DAMAGE_RECORD_SUFFIX)
}
