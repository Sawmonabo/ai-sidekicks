//! The record of how the daemon's last run on the database file ended, kept beside the file. A
//! start writes that it runs; a clean stop, once every connection has closed, replaces that with
//! the file's facts as it left them; a run that could not check the file removes it. A run that
//! ends any other way leaves the file sound: SQLite keeps every committed transaction across a
//! crash of the program, and in WAL mode a crash of the machine or a power loss can damage the file
//! only through a checkpoint whose syncs the storage did not honor, which the writer's checkpoints
//! rule out by flushing the drive. A file whose facts no longer match a clean stop's, or with no
//! record, was changed by something else, so a start cannot vouch for it. SQLite keeps no such flag
//! of its own, and a missing write-ahead log proves nothing. The facts come from one stat of each
//! file, never an open, since opening and closing the database file in this process would drop the
//! locks SQLite holds on it.

use std::io;
use std::path::Path;

use sidekicks_platforms::{FileFacts, file_facts, flush_folder};
use tokio::task::JoinError;

use crate::database_file::{WRITE_AHEAD_LOG_SUFFIX, store_folder};
use sidekicks_std::file::atomic_write::{AtomicWriteError, write_file_atomically};
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_store::database::sibling_path;

/// How the last run on the database file ended, as its record tells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LastRunEnd {
    /// There is no file yet.
    NewFile,
    /// A clean stop left the file as it is.
    Clean,
    /// The run ended without a clean stop.
    Unclean,
    /// There is no record, or the file changed since a clean stop.
    Unknown,
}

/// Why the last run's record could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum LastRunError {
    /// The file system refused a read or a removal of the record, or the flush of its folder.
    #[error(
        "the database file's last-run record could not be read or removed, or its folder flushed"
    )]
    Read(#[source] io::Error),
    /// The record could not be written.
    #[error("the database file's last-run record could not be written")]
    Write(#[source] AtomicWriteError),
    /// The blocking task that read the files' facts or flushed the folder ended first.
    #[error("the database file's last-run record task ended before it finished")]
    Interrupted(#[source] JoinError),
}

// What a running daemon's record holds, and how a clean stop's record starts.
const RUNNING_RECORD: &str = "running";
const CLEAN_PREFIX: &str = "clean ";

// The record's file beside the database file.
const LAST_RUN_SUFFIX: &str = ".last-run";

// The record is the person's alone.
const LAST_RUN_RECORD_MODE: u32 = 0o600;

/// Reads how the last run on the file at `database_path` ended. Fails when the file system refuses
/// a read; a record of another form reads [`LastRunEnd::Unknown`].
pub(crate) async fn read_last_run_end(database_path: &Path) -> Result<LastRunEnd, LastRunError> {
    let Some(description) = describe_database_file(database_path).await? else {
        return Ok(LastRunEnd::NewFile);
    };
    let Some(record) = tokio::fs::read(sibling_path(database_path, LAST_RUN_SUFFIX))
        .await
        .none_if_missing()
        .map_err(LastRunError::Read)?
    else {
        return Ok(LastRunEnd::Unknown);
    };
    if record == format!("{CLEAN_PREFIX}{description}").as_bytes() {
        Ok(LastRunEnd::Clean)
    } else if record == RUNNING_RECORD.as_bytes() {
        Ok(LastRunEnd::Unclean)
    } else {
        Ok(LastRunEnd::Unknown)
    }
}

/// Records that a run on the file at `database_path` has started, replacing the last run's record.
/// Fails when the record cannot be written.
pub(crate) async fn record_run_start(database_path: &Path) -> Result<(), LastRunError> {
    write_file_atomically(
        &sibling_path(database_path, LAST_RUN_SUFFIX),
        RUNNING_RECORD,
        LAST_RUN_RECORD_MODE,
    )
    .await
    .map_err(LastRunError::Write)
}

/// Records that the run stopped cleanly, with the facts of the file at `database_path` as it left
/// them. Called only once every connection to the file has closed, never after the writer ended
/// itself, whose file a start must check. Fails when a fact cannot be read or the record written.
pub(crate) async fn record_clean_stop(database_path: &Path) -> Result<(), LastRunError> {
    let description = describe_database_file(database_path)
        .await?
        .unwrap_or_else(|| describe(None, 0));
    write_file_atomically(
        &sibling_path(database_path, LAST_RUN_SUFFIX),
        format!("{CLEAN_PREFIX}{description}"),
        LAST_RUN_RECORD_MODE,
    )
    .await
    .map_err(LastRunError::Write)
}

/// Removes the record, so the next start cannot vouch for the file and holds its writes until its
/// check finds the file sound, and flushes the folder so the removal survives a power loss. Fails
/// when the removal or the flush fails; a record already gone is removed.
pub(crate) async fn forget_last_run(database_path: &Path) -> Result<(), LastRunError> {
    tokio::fs::remove_file(sibling_path(database_path, LAST_RUN_SUFFIX))
        .await
        .none_if_missing()
        .map_err(LastRunError::Read)?;
    let folder = store_folder(database_path).to_path_buf();
    tokio::task::spawn_blocking(move || flush_folder(&folder))
        .await
        .map_err(LastRunError::Interrupted)?
        .map_err(LastRunError::Read)
}

// The database file's facts and its log's size as a clean stop's record holds them, `None` when
// there is no database file; a missing log reads as size 0.
async fn describe_database_file(database_path: &Path) -> Result<Option<String>, LastRunError> {
    let database = database_path.to_path_buf();
    let log = sibling_path(database_path, WRITE_AHEAD_LOG_SUFFIX);
    let (facts, log_facts) = tokio::task::spawn_blocking(move || {
        Ok::<_, io::Error>((
            file_facts(&database).none_if_missing()?,
            file_facts(&log).none_if_missing()?,
        ))
    })
    .await
    .map_err(LastRunError::Interrupted)?
    .map_err(LastRunError::Read)?;
    Ok(facts.map(|facts| describe(Some(&facts), log_facts.map_or(0, |log| log.size))))
}

// The record's facts: the file's identity, size, modification and change times in nanoseconds,
// and its log's size, each 0 where there is no file.
fn describe(facts: Option<&FileFacts>, log_size: u64) -> String {
    match facts {
        Some(facts) => format!(
            "{} {} {} {} {log_size}",
            facts.identity, facts.size, facts.modified, facts.changed
        ),
        None => format!("0:0 0 0 0 {log_size}"),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{
        LastRunEnd, forget_last_run, read_last_run_end, record_clean_stop, record_run_start,
    };

    #[tokio::test]
    async fn tells_each_end_and_reads_a_file_changed_after_a_clean_stop_as_unknown() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let database = scratch.path().join("daemon.db");

        let before_any_file = read_last_run_end(&database).await.expect("the end reads");
        fs::write(&database, b"pages").expect("the file is written");
        let without_record = read_last_run_end(&database).await.expect("the end reads");
        record_run_start(&database)
            .await
            .expect("the start is recorded");
        let while_running = read_last_run_end(&database).await.expect("the end reads");
        record_clean_stop(&database)
            .await
            .expect("the stop is recorded");
        let after_clean_stop = read_last_run_end(&database).await.expect("the end reads");
        fs::write(&database, b"pages and more").expect("the file is changed");
        let after_change = read_last_run_end(&database).await.expect("the end reads");
        record_clean_stop(&database)
            .await
            .expect("the stop is recorded again");
        forget_last_run(&database)
            .await
            .expect("the record is removed");
        let after_forget = read_last_run_end(&database).await.expect("the end reads");

        assert_eq!(before_any_file, LastRunEnd::NewFile);
        assert_eq!(without_record, LastRunEnd::Unknown);
        assert_eq!(while_running, LastRunEnd::Unclean);
        assert_eq!(after_clean_stop, LastRunEnd::Clean);
        assert_eq!(after_change, LastRunEnd::Unknown);
        assert_eq!(after_forget, LastRunEnd::Unknown);
    }
}
