//! The `index` mode: the search index's build, in a child process the daemon starts and waits on,
//! so the build's memory goes with the process. It opens the daemon's database read-only, builds
//! the index from it and exits 0; a failed build writes why to standard error and exits 1. It also
//! exits 1 once its standard input ends, which the daemon's going or a canceled build closes, so it
//! never outlives the wait for it; a build cut short leaves only its own folder, which the next
//! build clears.

use std::env;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

use sidekicks_search::index::IndexRowKind;
use strum::VariantArray;

use crate::search::index::rebuild::{SearchIndexBuildError, build_search_index};
use crate::search::index::rows::IndexRowReader;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::helper_mode::input_watch::run_until_input_ends;
use sidekicks_store::database::connection::setup::open_database_reader;

/// The argument the daemon's own program is started with to run the search index's build.
pub(crate) const SEARCH_INDEX_BUILD_MODE: &str = "index";

// The build's statements: each kind's highest rowid and its rows in a rowid range.
const BUILD_STATEMENT_CAPACITY: usize = 2 * IndexRowKind::VARIANTS.len();

/// Why the `index` mode's build failed.
#[derive(Debug, thiserror::Error)]
enum SearchIndexBuildModeError {
    /// The mode was not started with the database, the index folder and the outbox id.
    #[error(
        "the search index's build is started with the database, the index folder and the outbox id"
    )]
    Arguments,
    /// The database did not open for reading.
    #[error(transparent)]
    Database(#[from] CleanupFailures<rusqlite::Error>),
    /// The build failed, with the database closed after it.
    #[error(transparent)]
    Build(#[from] Box<CleanupFailures<SearchIndexBuildError, rusqlite::Error>>),
    /// The index was built and placed, but the database did not close.
    #[error("the database did not close after the search index's build")]
    Close(#[source] rusqlite::Error),
}

/// Runs the `index` mode on the arguments after the mode's own: the database's path, the index
/// folder's absolute path and the outbox id every commit records. Exits 0 once the index is built
/// and in place, 1 with why on standard error when the build fails, and 1 as soon as standard input
/// ends, the build's thread ending with the process. Runs before the daemon's runtime, log or
/// allocator timer would start.
pub(crate) fn run_search_index_build() -> ExitCode {
    run_until_input_ends(|| build_from_arguments(env::args_os().skip(2)))
}

// Builds the index from the database the arguments name, closing the database after.
fn build_from_arguments(
    mut arguments: impl Iterator<Item = OsString>,
) -> Result<(), SearchIndexBuildModeError> {
    let (Some(database_path), Some(index_folder), Some(last_outbox_id)) =
        (arguments.next(), arguments.next(), arguments.next())
    else {
        return Err(SearchIndexBuildModeError::Arguments);
    };
    let last_outbox_id: u64 = last_outbox_id
        .to_str()
        .and_then(|id| id.parse().ok())
        .ok_or(SearchIndexBuildModeError::Arguments)?;
    let reader = open_database_reader(&PathBuf::from(database_path), BUILD_STATEMENT_CAPACITY)?;
    let built = build_search_index(
        &PathBuf::from(index_folder),
        &IndexRowReader::new(&reader),
        last_outbox_id,
    );
    let closed = reader.close().map_err(|(_, close_failure)| close_failure);
    match (built, closed) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(close_failure)) => Err(SearchIndexBuildModeError::Close(close_failure)),
        (Err(build_failure), closed) => Err(Box::new(CleanupFailures::new(
            build_failure,
            closed.err().into_iter().collect(),
            "the search index's build",
        ))
        .into()),
    }
}
