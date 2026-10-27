//! Opens the search index at the daemon's start, or says why it must be built again from the
//! database: its folder is missing, its files cannot be read as an index, or its newest commit
//! records an outbox id this database never gave, so it was built from another database. A build
//! runs in a child process the daemon starts and waits on, so the build's memory goes with that
//! process. It writes into a folder beside the index's, merges it and renames it into place once
//! whole, so a build cut short leaves no half-built index; every commit records the outbox's
//! highest id at the build's start, and the outbox rows past it are applied after, as at any start.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;

use sidekicks_platforms::{Spawner, flush_folder, remove_tree, rename_replacing};
use sidekicks_search::index::{
    IndexBatch, IndexRowKind, SearchIndex, SearchIndexError, SearchIndexOptions,
};
use strum::VariantArray;
use tokio::process::Command;
use tokio::task::JoinError;
use tokio_util::sync::CancellationToken;

use crate::search::index::batch_builder::IndexBatchBuilder;
use crate::search::index::build_mode::SEARCH_INDEX_BUILD_MODE;
use crate::search::index::columns::source_rowid_of;
use crate::search::index::rows::{
    INDEX_BATCH_ROW_LIMIT, INDEX_BATCH_TEXT_LIMIT, IndexRowReader, SourceRowRead,
    empty_index_batch_room,
};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::helper_mode::child::{
    HelperModeChildError, HelperModeEnd, run_helper_mode_child,
};

// The indexing arena, at its budget's ceiling: the larger the arena, the fewer segments a batch
// flushes and the less merging follows.
const SEARCH_INDEX_OPTIONS: SearchIndexOptions = SearchIndexOptions {
    writer_memory_bytes: 64 * 1024 * 1024,
};

// The most of the build's standard error a failure keeps: its last 16 KiB, where a failure's own
// words sit.
const STANDARD_ERROR_TAIL_BYTES: usize = 16 * 1024;

/// Why the index was built again at a start, logged by its word (`anotherDatabase`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, strum::IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub enum SearchIndexRebuildReason {
    /// The index's folder was missing.
    Missing,
    /// The folder's files could not be read as an index; the folder was removed.
    Unreadable,
    /// The index's newest commit records an outbox id this database never gave; the folder was
    /// removed.
    AnotherDatabase,
}

/// What an open at a start found: the index ready to serve, or why it must be built again.
pub(crate) enum SearchIndexOpening {
    /// The index, in step with this database up to its last applied outbox id.
    Opened(Box<SearchIndex>),
    /// The index must be built again, any folder it left already removed.
    RebuildNeeded(SearchIndexRebuildReason),
}

/// Why an open at a start failed.
#[derive(Debug, thiserror::Error)]
pub enum SearchIndexOpenError {
    /// The folder's presence could not be read, or a folder that could not serve was not removed.
    #[error("the search index folder could not be read or removed")]
    Folder(#[source] io::Error),
    /// The index failed the open, or the close of an index built from another database.
    #[error(transparent)]
    Index(#[from] SearchIndexError),
    /// The blocking task that opened the index did not finish.
    #[error("opening the search index did not finish")]
    Join(#[from] JoinError),
}

/// What a build in a child process reads and writes.
#[derive(Clone, Debug)]
pub(crate) struct SearchIndexBuildRequest {
    /// The daemon's database, which the build reads.
    pub(crate) database_path: PathBuf,
    /// The index's folder, which the build fills.
    pub(crate) index_folder: PathBuf,
    /// The outbox's highest id, read before the build reads any row, so every write the build may
    /// miss sits in the outbox past it; every commit of the build records it.
    pub(crate) last_outbox_id: u64,
}

/// Why a build in a child process did not finish.
#[derive(Debug, thiserror::Error)]
pub enum SearchIndexChildError {
    /// The cancellation came before the build ended; the process has exited.
    #[error("the search index's build was canceled")]
    Canceled,
    /// The process could not be started.
    #[error("the search index's build could not be started")]
    Spawn(#[source] io::Error),
    /// The wait for the process's exit, or the read of its standard error, failed.
    #[error("the search index's build could not be waited on")]
    Wait(#[source] io::Error),
    /// The process ended with a failure: its exit code or the signal that ended it, and the tail
    /// of what it wrote to standard error.
    #[error("the search index's build ended with {status}: {standard_error}")]
    Failed {
        /// How the process ended; its text names the code, or the signal by name.
        status: ExitStatus,
        /// The tail of the process's standard error.
        standard_error: String,
    },
}

/// Why a build failed; the build's folder may be left, which the next build clears.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SearchIndexBuildError {
    /// A build folder left by an earlier build could not be cleared.
    #[error("the search index's leftover build folder could not be cleared")]
    Clear(#[source] io::Error),
    /// The index in the build folder did not open.
    #[error("the search index's build folder did not open as an index")]
    Open(#[source] SearchIndexError),
    /// A read or a write of the build failed, with the index closed after it.
    #[error(transparent)]
    Indexing(#[from] CleanupFailures<SearchIndexBuildStepError, SearchIndexError>),
    /// The built index did not close.
    #[error("the built search index did not close")]
    Close(#[source] SearchIndexError),
    /// The built folder could not be renamed into place, or the rename flushed to disk.
    #[error("the built search index could not be moved into place")]
    Place(#[source] io::Error),
}

/// A step of a build that failed: a read of the rows to index, or the index's apply or merge.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SearchIndexBuildStepError {
    /// SQLite refused a read of the rows, or a stored value did not read as its type.
    #[error("a read of the rows to index failed")]
    Read(#[from] rusqlite::Error),
    /// The index refused a batch or a merge.
    #[error(transparent)]
    Index(#[from] SearchIndexError),
}

/// The index in `folder`, or why it must be built again, with any folder it left removed. An index
/// whose last applied outbox id is past `highest_id_given`, the outbox's highest, is closed and
/// removed. Fails with what the open, the close or the folder's removal failed with.
pub(crate) async fn open_search_index(
    folder: PathBuf,
    highest_id_given: u64,
) -> Result<SearchIndexOpening, SearchIndexOpenError> {
    if !tokio::fs::try_exists(&folder)
        .await
        .map_err(SearchIndexOpenError::Folder)?
    {
        return Ok(SearchIndexOpening::RebuildNeeded(
            SearchIndexRebuildReason::Missing,
        ));
    }
    tokio::task::spawn_blocking(move || open_in_step(&folder, highest_id_given)).await?
}

// The open itself, which blocks on the index's files.
fn open_in_step(
    folder: &Path,
    highest_id_given: u64,
) -> Result<SearchIndexOpening, SearchIndexOpenError> {
    let index = match SearchIndex::open(folder, SEARCH_INDEX_OPTIONS) {
        Ok(index) => index,
        Err(SearchIndexError::Unreadable(_)) => {
            remove_tree(folder).map_err(SearchIndexOpenError::Folder)?;
            return Ok(SearchIndexOpening::RebuildNeeded(
                SearchIndexRebuildReason::Unreadable,
            ));
        }
        Err(error @ (SearchIndexError::Closed | SearchIndexError::Index(_))) => {
            return Err(error.into());
        }
    };
    if index.last_applied_outbox_id() <= highest_id_given {
        return Ok(SearchIndexOpening::Opened(Box::new(index)));
    }
    index.close()?;
    // Dropped first, so no file of it is open when its folder goes.
    drop(index);
    remove_tree(folder).map_err(SearchIndexOpenError::Folder)?;
    Ok(SearchIndexOpening::RebuildNeeded(
        SearchIndexRebuildReason::AnotherDatabase,
    ))
}

/// Builds the index again from the database in a child process of `program`, the daemon's own,
/// and waits for it to exit; that one extra process exists only while a build runs. The child is
/// started on `spawner` and holds the build until its standard input ends. Fails with what the
/// process wrote to standard error and how it ended when it ended with a failure; once
/// `cancellation` fires, standard input is closed, the process's exit waited for, and the build
/// answers [`SearchIndexChildError::Canceled`], so no build outlives the wait for it.
pub(crate) async fn build_search_index_in_child(
    spawner: &Spawner,
    program: &Path,
    request: &SearchIndexBuildRequest,
    cancellation: &CancellationToken,
) -> Result<(), SearchIndexChildError> {
    let mut command = Command::new(program);
    command
        .arg(SEARCH_INDEX_BUILD_MODE)
        .arg(&request.database_path)
        .arg(&request.index_folder)
        .arg(request.last_outbox_id.to_string())
        // Freed memory goes back to the system at once, for the lowest peak footprint.
        .env("MIMALLOC_PURGE_DELAY", "0");
    let ended = run_helper_mode_child(spawner, command, cancellation, STANDARD_ERROR_TAIL_BYTES)
        .await
        .map_err(|failure| match failure {
            HelperModeChildError::Start(failure) => SearchIndexChildError::Spawn(failure),
            HelperModeChildError::Wait(failure) => SearchIndexChildError::Wait(failure),
        })?;
    match ended {
        HelperModeEnd::Succeeded => Ok(()),
        HelperModeEnd::Stopped => Err(SearchIndexChildError::Canceled),
        HelperModeEnd::Failed {
            status,
            error_output,
        } => Err(SearchIndexChildError::Failed {
            status,
            standard_error: error_output,
        }),
    }
}

// Where a build has read one kind's rows to, and its table's highest rowid when the build started:
// a row past it was written after the outbox id the build records, so the outbox carries it.
struct KindReading {
    kind: IndexRowKind,
    last_rowid: u64,
    after_rowid: u64,
}

/// Indexes every source row `rows` reads into `<folder>.building`, each commit recording
/// `last_outbox_id`, merges its segments, then renames it to `folder` and flushes the parent
/// folder; `folder` is an absolute path. A build folder an earlier build left is cleared first.
/// Blocks throughout; the `index` mode runs it in its own process. Fails with what a read, the
/// index or a folder step failed with, with the index closed.
pub(crate) fn build_search_index(
    folder: &Path,
    rows: &IndexRowReader<'_>,
    last_outbox_id: u64,
) -> Result<(), SearchIndexBuildError> {
    let parent = folder
        .parent()
        .expect("the index folder is an absolute path inside the daemon's data folder");
    let mut building_name = OsString::from(folder.as_os_str());
    building_name.push(".building");
    let building = PathBuf::from(building_name);
    // A build a start cut short left its folder; this build starts from an empty one.
    remove_tree(&building).map_err(SearchIndexBuildError::Clear)?;
    let index =
        SearchIndex::open(&building, SEARCH_INDEX_OPTIONS).map_err(SearchIndexBuildError::Open)?;
    if let Err(error) = fill_and_merge(&index, rows, last_outbox_id) {
        return Err(close_after_failure(&index, error, "the search index's build").into());
    }
    index.close().map_err(SearchIndexBuildError::Close)?;
    drop(index);
    rename_replacing(&building, folder).map_err(SearchIndexBuildError::Place)?;
    flush_folder(parent).map_err(SearchIndexBuildError::Place)
}

// Applies every batch, a row too long for one over several, then merges until nothing is left to
// merge, so the daemon opens an index with none of the build's merging left to do.
fn fill_and_merge(
    index: &SearchIndex,
    rows: &IndexRowReader<'_>,
    last_outbox_id: u64,
) -> Result<(), SearchIndexBuildStepError> {
    let reading_of = |kind: IndexRowKind| -> rusqlite::Result<KindReading> {
        Ok(KindReading {
            kind,
            last_rowid: u64::try_from(rows.last_rowid(kind)?)
                .expect("a table's highest rowid is never negative"),
            after_rowid: 0,
        })
    };
    let mut log_reading = reading_of(IndexRowKind::Event)?;
    let mut other_readings = IndexRowKind::VARIANTS
        .iter()
        .filter(|kind| **kind != IndexRowKind::Event)
        .map(|kind| reading_of(*kind))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    loop {
        let batch_rows = read_next_batch(rows, &mut log_reading, &mut other_readings)?;
        if batch_rows.is_empty() {
            break;
        }
        let mut builder = IndexBatchBuilder::new(INDEX_BATCH_TEXT_LIMIT);
        for row in batch_rows {
            builder.add_row(rows, row, last_outbox_id, &mut |batch: &IndexBatch| {
                index.apply(batch).map_err(SearchIndexBuildStepError::from)
            })?;
        }
        index.apply(&builder.finish(last_outbox_id))?;
    }
    while index.merge_segments()? {}
    Ok(())
}

// A build's next batch: the next log rows, nearly every row the index holds, then each other
// kind's rows through the same share of its table's rowids, or all its rows left once the log rows
// are read. Each segment the build writes then mixes the kinds as the whole index does, so the
// average row length its blocks' score bounds were chosen under is the index's. Every read takes
// from the batch's one room, so a batch holds at most the batch row limit and about the text limit,
// and a merge of five batches fills the merge cap. The log rows stop where the other kinds' rows
// through the same share, at most one a rowid, would no longer fit, so the batch keeps every row it
// takes; the first log row is always taken, so each batch moves on.
fn read_next_batch(
    rows: &IndexRowReader<'_>,
    log_reading: &mut KindReading,
    other_readings: &mut [KindReading],
) -> rusqlite::Result<Vec<SourceRowRead>> {
    let mut room = empty_index_batch_room();
    let other_rows_at_most = |log_rowid: u64| -> u64 {
        other_readings
            .iter()
            .map(|reading| {
                through_rowid_of(reading, log_reading, log_rowid)
                    .saturating_sub(reading.after_rowid)
            })
            .sum()
    };
    // The log is the batch's first read, so the room has given up one row for each log row taken.
    let mut log_rows_taken = 0_usize;
    let log_rows = rows.read_rows_between(
        log_reading.kind,
        sqlite_rowid(log_reading.after_rowid),
        sqlite_rowid(log_reading.last_rowid),
        &mut room,
        |row| {
            let rows_left = INDEX_BATCH_ROW_LIMIT - log_rows_taken;
            let fits = rows_left == INDEX_BATCH_ROW_LIMIT
                || (rows_left - 1) as u64 >= other_rows_at_most(source_rowid_of(row.key()));
            if fits {
                log_rows_taken += 1;
            }
            fits
        },
    )?;
    read_on(log_reading, &log_rows);
    let last_log_rowid = log_rows.last().map(|row| source_rowid_of(row.key()));
    let mut batch_rows = log_rows;
    for reading in other_readings.iter_mut() {
        let through_rowid = match last_log_rowid {
            Some(log_rowid) => through_rowid_of(reading, log_reading, log_rowid),
            None => reading.last_rowid,
        };
        let kind_rows = rows.read_rows_between(
            reading.kind,
            sqlite_rowid(reading.after_rowid),
            sqlite_rowid(through_rowid),
            &mut room,
            |_| true,
        )?;
        read_on(reading, &kind_rows);
        batch_rows.extend(kind_rows);
    }
    Ok(batch_rows)
}

// The rowid of `reading`'s table through which the share of the log's rowids up to `log_rowid`
// reaches. Called only once a log row was read, so the log's highest rowid is at least 1.
fn through_rowid_of(reading: &KindReading, log_reading: &KindReading, log_rowid: u64) -> u64 {
    let share =
        u128::from(log_rowid) * u128::from(reading.last_rowid) / u128::from(log_reading.last_rowid);
    u64::try_from(share).expect("the share is at most the kind's highest rowid")
}

// Moves `reading` past the last of `kind_rows`.
fn read_on(reading: &mut KindReading, kind_rows: &[SourceRowRead]) {
    if let Some(last_row) = kind_rows.last() {
        reading.after_rowid = source_rowid_of(last_row.key());
    }
}

// A rowid as SQLite binds it.
fn sqlite_rowid(rowid: u64) -> i64 {
    i64::try_from(rowid).expect("a SQLite rowid is below 2^63")
}

/// `error` once `index` is closed after it, carrying what the close failed with when it failed
/// too; `operation` names what failed. Blocks on the close, so an async caller runs it off the
/// runtime.
pub(crate) fn close_after_failure<Failure>(
    index: &SearchIndex,
    error: Failure,
    operation: &'static str,
) -> CleanupFailures<Failure, SearchIndexError> {
    let cleanup_failures = match index.close() {
        Ok(()) => Vec::new(),
        Err(close_failure) => vec![close_failure],
    };
    CleanupFailures::new(error, cleanup_failures, operation)
}

/// Makes an index in `folder` whose newest commit records `last_outbox_id` and holds no row, for a
/// test.
#[cfg(test)]
pub(crate) fn make_index_at(folder: &Path, last_outbox_id: u64) {
    let index = SearchIndex::open(folder, SEARCH_INDEX_OPTIONS).expect("a fresh index opens");
    index
        .apply(&IndexBatchBuilder::new(INDEX_BATCH_TEXT_LIMIT).finish(last_outbox_id))
        .expect("the batch applies");
    index.close().expect("the index closes");
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rstest::rstest;
    use rusqlite::Connection;
    use sidekicks_search::index::SearchIndex;

    use super::{
        SEARCH_INDEX_OPTIONS, SearchIndexOpening, SearchIndexRebuildReason, build_search_index,
        make_index_at, open_search_index,
    };
    use crate::questions::schema::schema_parts;
    use crate::search::index::rows::IndexRowReader;
    use crate::search::index::schema::add_titled_session;

    // A database holding one titled session, whose insert gave the outbox its first ids, and the
    // outbox's highest id.
    fn database_with_one_session() -> (Connection, u64) {
        let connection = Connection::open_in_memory().expect("an in-memory database opens");
        connection
            .execute_batch(schema_parts().into_schema().sql())
            .expect("the session's schema runs");
        let highest_id_given = add_titled_session(&connection, "session-1");
        assert!(
            highest_id_given > 0,
            "the session's insert wrote an outbox row"
        );
        (connection, highest_id_given)
    }

    #[tokio::test]
    async fn a_missing_folder_is_built_again() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let opening = open_search_index(scratch.path().join("index"), 0)
            .await
            .expect("the open settles");
        assert!(matches!(
            opening,
            SearchIndexOpening::RebuildNeeded(SearchIndexRebuildReason::Missing)
        ));
    }

    #[tokio::test]
    async fn an_unreadable_folder_is_removed_and_built_again() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let folder = scratch.path().join("index");
        make_index_at(&folder, 1);
        let meta_path = folder.join("meta.json");
        let mut meta: serde_json::Value =
            serde_json::from_slice(&fs::read(&meta_path).expect("meta.json reads"))
                .expect("meta.json parses");
        meta["payload"] = serde_json::Value::from("not a payload");
        fs::write(&meta_path, meta.to_string()).expect("meta.json writes");
        let opening = open_search_index(folder.clone(), 1)
            .await
            .expect("the open settles");
        assert!(matches!(
            opening,
            SearchIndexOpening::RebuildNeeded(SearchIndexRebuildReason::Unreadable)
        ));
        assert!(!folder.exists(), "the unreadable folder is removed");
    }

    // An index's last applied outbox id at the outbox's highest opens; one past it was built from
    // another database, so it is removed.
    #[rstest]
    #[case::at_the_outbox_s_highest_id(0)]
    #[case::one_past_it(1)]
    #[tokio::test]
    async fn an_index_past_the_outbox_s_highest_id_is_from_another_database(#[case] past: u64) {
        let (_database, highest_id_given) = database_with_one_session();
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let folder = scratch.path().join("index");
        make_index_at(&folder, highest_id_given + past);
        let opening = open_search_index(folder.clone(), highest_id_given)
            .await
            .expect("the open settles");
        match opening {
            SearchIndexOpening::Opened(index) => {
                assert_eq!(past, 0, "only an index within the outbox's ids opens");
                assert_eq!(index.last_applied_outbox_id(), highest_id_given);
                index.close().expect("the index closes");
            }
            SearchIndexOpening::RebuildNeeded(reason) => {
                assert_eq!(
                    past, 1,
                    "an index within the outbox's ids is not built again"
                );
                assert_eq!(reason, SearchIndexRebuildReason::AnotherDatabase);
                assert!(!folder.exists(), "the other database's index is removed");
            }
        }
    }

    #[test]
    fn a_build_clears_a_leftover_build_folder() {
        let (database, highest_id_given) = database_with_one_session();
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let folder = scratch.path().join("index");
        let building = scratch.path().join("index.building");
        fs::create_dir(&building).expect("the leftover build folder is made");
        fs::write(building.join("leftover"), "cut short").expect("the leftover file is written");
        build_search_index(&folder, &IndexRowReader::new(&database), highest_id_given)
            .expect("the build finishes");
        assert!(!building.exists(), "the build folder is renamed into place");
        assert!(
            !folder.join("leftover").exists(),
            "the leftover file is not in the built index"
        );
        let index =
            SearchIndex::open(&folder, SEARCH_INDEX_OPTIONS).expect("the built index opens");
        assert_eq!(index.last_applied_outbox_id(), highest_id_given);
        index.close().expect("the index closes");
    }
}
