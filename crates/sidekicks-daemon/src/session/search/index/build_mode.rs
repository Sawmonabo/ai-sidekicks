//! The `index` mode: the search index's build, in a child process the daemon starts and waits on,
//! so the build's memory goes with the process. It opens the daemon's database read-only, builds
//! the index from it and exits 0; a failed build writes why to standard error and exits 1. It also
//! exits 1 once its standard input ends, which the daemon's going or a canceled build closes, so it
//! never outlives the wait for it; a build cut short leaves only its own folder, which the next
//! build clears.

use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;

use sidekicks_search::index::IndexRowKind;
use strum::VariantArray;

use crate::cleanup_failures::CleanupFailures;
use crate::database::connection::setup::open_database_reader;
use crate::session::search::index::rebuild::{SearchIndexBuildError, build_search_index};
use crate::session::search::index::rows::IndexRowReader;

/// The argument the daemon's own program is started with to run the search index's build.
pub(crate) const SEARCH_INDEX_BUILD_MODE: &str = "index";

// The build's statements: each kind's highest rowid and its rows in a rowid range.
const BUILD_STATEMENT_CAPACITY: usize = 2 * IndexRowKind::VARIANTS.len();

// What ended the mode first: the build, or the end of standard input.
enum BuildModeEnd {
    Build(Result<(), SearchIndexBuildModeError>),
    Input(io::Result<()>),
}

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
    Build(#[from] CleanupFailures<SearchIndexBuildError, rusqlite::Error>),
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
    let (ended, first_end) = mpsc::channel();
    let input_ended = ended.clone();
    // Standard input carries nothing; its end says the daemon stopped waiting for the build.
    let watching = thread::Builder::new().spawn(move || {
        let read = io::copy(&mut io::stdin().lock(), &mut io::sink()).map(|_| ());
        // A send fails only once the mode has answered, and the process is ending.
        input_ended.send(BuildModeEnd::Input(read)).unwrap_or(());
    });
    let building = thread::Builder::new().spawn(move || {
        let built = build_from_arguments(env::args_os().skip(2));
        ended.send(BuildModeEnd::Build(built)).unwrap_or(());
    });
    if let Err(failure) = watching.and(building) {
        return exit_with_failure(&failure);
    }
    match first_end
        .recv()
        .expect("a thread holds a sender until it sends its end")
    {
        BuildModeEnd::Build(Ok(())) => ExitCode::SUCCESS,
        BuildModeEnd::Build(Err(failure)) => exit_with_failure(&failure),
        BuildModeEnd::Input(Ok(())) => ExitCode::FAILURE,
        BuildModeEnd::Input(Err(failure)) => exit_with_failure(&failure),
    }
}

// Writes `failure` and its causes to standard error, whose tail the daemon keeps, and answers the
// failed exit; when the write fails, the exit code alone tells the daemon.
fn exit_with_failure(failure: &(dyn Error + 'static)) -> ExitCode {
    let mut standard_error = io::stderr().lock();
    let mut written = write!(standard_error, "{failure}");
    let mut cause = failure.source();
    while let Some(source) = cause {
        written = written.and_then(|()| write!(standard_error, ": {source}"));
        cause = source.source();
    }
    match written.and_then(|()| writeln!(standard_error)) {
        Ok(()) | Err(_) => ExitCode::FAILURE,
    }
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
        (Err(build_failure), closed) => Err(CleanupFailures::new(
            build_failure,
            closed.err().into_iter().collect(),
            "the search index's build",
        )
        .into()),
    }
}
