//! `session.file.search`, the `@` search: the session's working folder listed, ranked by the
//! product's one fuzzy scorer with an entry's own name before its path, and cut to a fixed count.
//! A row whose real location is not strictly inside the working folder is dropped, so no answer
//! follows a link out of it or back to the folder itself. The `@` box searches once a burst of
//! typing pauses, so each search reads the folder once, and searches that arrive while a read of
//! their folder is under way share it.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::FutureExt as _;
use futures::future::{BoxFuture, Shared};
use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{
    SessionFileSearchEntry, SessionFileSearchEntryKind, SessionFileSearchRequest,
    SessionFileSearchResponse,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::{is_link_loop, real_path};
use sidekicks_search::ranking::score_subsequence;
use tokio::task::JoinError;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::git::process::{GitError, GitRunner};
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::session::search::files::listing::{
    ListingError, WorkingFolderListing, list_working_folder,
};
use crate::session::working_folder::{WorkingFolderReadError, read_working_folder};

/// The statements the file search prepares on a read connection: the session's working folder.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start sizes the read connections' statement caches with it"
    )
)]
pub(crate) const FILE_SEARCH_STATEMENT_CAPACITY: usize = 1;

/// The most rows one `@` search answers.
const FILE_SEARCH_RESULT_MAX: usize = 50;

/// A working folder's rows as the searches share them, and how many files they were drawn from.
struct FolderCandidates {
    /// Every listed file and folder whose path a row can carry, in listing order.
    entries: Vec<SessionFileSearchEntry>,
    /// The files listed, those no row can carry among them.
    searched_file_count: usize,
    /// The files no row can carry: a name that is not UTF-8 or a path the row's type refuses.
    dropped_file_count: usize,
}

/// One working folder's listing under way, which the searches arriving meanwhile share.
type SharedListing = Shared<BoxFuture<'static, Result<Arc<FolderCandidates>, Arc<ListingError>>>>;

/// Why a file search was refused or failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum FileSearchError {
    /// The session is unknown (`session.notFound`), or its working folder is not in place
    /// (`session.workingFolder.missing`).
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// SQLite refused the read of the session's working folder.
    #[error("the read of the session's working folder failed")]
    Read(#[from] rusqlite::Error),
    /// No read connection could be had.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The session works in a WSL 2 distribution, where the daemon runs no git.
    #[error(transparent)]
    Git(#[from] GitError),
    /// The working folder could not be listed.
    #[error("the session's working folder could not be listed")]
    Listing(#[source] Arc<ListingError>),
    /// A path's real location could not be read for a reason other than its being gone.
    #[error("a listed path's real location could not be read")]
    Resolve(#[source] io::Error),
    /// The blocking task that read real locations did not finish.
    #[error("the read of the listed paths' real locations did not finish")]
    ResolveTask(#[source] JoinError),
}

impl From<WorkingFolderReadError> for FileSearchError {
    fn from(error: WorkingFolderReadError) -> Self {
        match error {
            WorkingFolderReadError::Refused(refusal) => Self::Refused(refusal),
            WorkingFolderReadError::Database(database) => Self::Read(database),
        }
    }
}

impl From<FileSearchError> for HandlerError {
    /// A refusal answers by its code; any other failure is a fault in the daemon.
    fn from(error: FileSearchError) -> Self {
        match error {
            FileSearchError::Refused(refusal) => Self::Refused(refusal),
            fault @ (FileSearchError::Read(_)
            | FileSearchError::Pool(_)
            | FileSearchError::Git(_)
            | FileSearchError::Listing(_)
            | FileSearchError::Resolve(_)
            | FileSearchError::ResolveTask(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// Answers `session.file.search` over each session's working folder.
pub(crate) struct FileSearchService {
    pool: Arc<DatabaseReadPool>,
    git: GitRunner,
    /// Each working folder's listing under way; a listing takes itself out once it settles, so
    /// the next search sees the folder as it is then.
    listings: Arc<Mutex<HashMap<PathBuf, SharedListing>>>,
}

impl FileSearchService {
    /// The search reading each session's working folder through `pool` and listing it through
    /// `git`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's start builds the `@` file search")
    )]
    pub(crate) fn new(pool: Arc<DatabaseReadPool>, git: GitRunner) -> Self {
        Self {
            pool,
            git,
            listings: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// The best matching files and folders, each path relative to the working folder, at most
    /// 50. Refused `session.notFound` for an unknown session and `session.workingFolder.missing`
    /// for a working folder that is not in place; fails with `Git` for a session in a WSL 2
    /// distribution, and as the folder's read, its listing or a path's real location fails.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the `session.file.search` handler answers the `@` search through it"
        )
    )]
    pub(crate) async fn search(
        &self,
        request: SessionFileSearchRequest,
    ) -> Result<SessionFileSearchResponse, FileSearchError> {
        let session_id = request.session_id;
        let working_folder = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, FileSearchError>(read_working_folder(reader, &session_id)?)
            })
            .await?;
        let Some(folder) = working_folder.working_folder else {
            return Err(working_folder_missing(&session_id).into());
        };
        if let Some(Place::Wsl(wsl)) = &working_folder.place {
            return Err(GitError::WslPlace {
                distro: wsl.distro.clone(),
            }
            .into());
        }
        let root_folder = folder.clone();
        let root = match tokio::task::spawn_blocking(move || real_path(&root_folder))
            .await
            .map_err(FileSearchError::ResolveTask)?
        {
            Ok(root) => root,
            Err(error) if is_gone(&error) => {
                return Err(working_folder_missing(&session_id)
                    .with_source(error)
                    .into());
            }
            Err(error) => return Err(FileSearchError::Resolve(error)),
        };
        let candidates = self
            .listing_of(working_folder.place, folder.clone())
            .await
            .map_err(FileSearchError::Listing)?;
        if candidates.dropped_file_count > 0 {
            tracing::warn!(
                session_id = session_id.text().as_str(),
                dropped_file_count = candidates.dropped_file_count,
                "the file search left out files whose names no row can carry"
            );
        }
        let ranked = ranked_entries(&candidates.entries, request.query.as_str());
        let searched_file_count = candidates.searched_file_count;
        let entries = tokio::task::spawn_blocking(move || {
            contained_entries(&candidates.entries, &ranked, &folder, &root)
        })
        .await
        .map_err(FileSearchError::ResolveTask)?
        .map_err(FileSearchError::Resolve)?;
        Ok(SessionFileSearchResponse {
            entries,
            searched_file_count: u64::try_from(searched_file_count)
                .ok()
                .and_then(SafeInt::new)
                .expect("a folder lists fewer than 2^53 files"),
        })
    }

    // The folder's listing: the one under way when there is one, else a new one, which takes
    // itself out of the map once it settles.
    fn listing_of(&self, place: Option<Place>, folder: PathBuf) -> SharedListing {
        let mut listings = lock_listings(&self.listings);
        if let Some(under_way) = listings.get(&folder) {
            return under_way.clone();
        }
        let git = self.git.clone();
        let settled_listings = Arc::clone(&self.listings);
        let key = folder.clone();
        let listing = async move {
            let listed = list_working_folder(&git, place.as_ref(), &folder)
                .await
                .map(|listing| Arc::new(candidates_of(listing)))
                .map_err(Arc::new);
            lock_listings(&settled_listings).remove(&folder);
            listed
        }
        .boxed()
        .shared();
        listings.insert(key, listing.clone());
        listing
    }
}

fn lock_listings(
    listings: &Mutex<HashMap<PathBuf, SharedListing>>,
) -> MutexGuard<'_, HashMap<PathBuf, SharedListing>> {
    // The map holds no invariant a panicking holder could break.
    listings.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `session.workingFolder.missing`: the session's working folder is not in place, yet or any
/// more, so it cannot be searched. The session's id goes out as the refusal's detail.
fn working_folder_missing(session_id: &SessionId) -> DomainError {
    DomainError::new(
        "The session's working folder is not in place, so it cannot be searched.",
        RefusalCode::SessionWorkingFolderMissing,
    )
    .with_detail(json!({ "sessionId": session_id }))
}

// Whether a path's real location failed because the path, or a folder on its way, is gone.
fn is_gone(error: &io::Error) -> bool {
    let kind = error.kind();
    kind == io::ErrorKind::NotFound || kind == io::ErrorKind::NotADirectory
}

// The listing's entries as rows, a path the row's type refuses left out and, for a file,
// counted.
fn candidates_of(listing: WorkingFolderListing) -> FolderCandidates {
    let mut entries = Vec::with_capacity(listing.entries.len());
    let mut file_count = 0;
    let mut dropped_file_count = listing.dropped_file_count;
    for listed in listing.entries {
        let is_file = listed.kind == SessionFileSearchEntryKind::File;
        match FilesystemPath::new(listed.path) {
            Ok(path) => {
                file_count += usize::from(is_file);
                entries.push(SessionFileSearchEntry {
                    path,
                    kind: listed.kind,
                });
            }
            Err(_refused) => dropped_file_count += usize::from(is_file),
        }
    }
    FolderCandidates {
        entries,
        searched_file_count: file_count + dropped_file_count,
        dropped_file_count,
    }
}

/// One entry the query matched.
struct RankedEntry {
    index: usize,
    /// A match on the entry's own name outranks a match on its path alone.
    is_name_match: bool,
    score: f64,
}

// The indexes of every entry the query matches, best first; an empty query keeps every entry, in
// path order.
fn ranked_entries(entries: &[SessionFileSearchEntry], query: &str) -> Vec<usize> {
    if query.is_empty() {
        let mut indexes: Vec<usize> = (0..entries.len()).collect();
        indexes.sort_by(|&left, &right| {
            path_order(entries[left].path.as_str(), entries[right].path.as_str())
        });
        return indexes;
    }
    let query_units: Vec<u16> = query.encode_utf16().collect();
    let mut candidate_units = Vec::new();
    let mut ranked = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let path = entry.path.as_str();
        let name = path.rsplit('/').next().unwrap_or(path);
        candidate_units.clear();
        candidate_units.extend(name.encode_utf16());
        let (is_name_match, matched) = match score_subsequence(&candidate_units, &query_units) {
            Some(matched) => (true, Some(matched)),
            None => {
                candidate_units.clear();
                candidate_units.extend(path.encode_utf16());
                (false, score_subsequence(&candidate_units, &query_units))
            }
        };
        if let Some(matched) = matched {
            ranked.push(RankedEntry {
                index,
                is_name_match,
                score: matched.score,
            });
        }
    }
    ranked.sort_by(|left, right| {
        right
            .is_name_match
            .cmp(&left.is_name_match)
            .then_with(|| right.score.total_cmp(&left.score))
            .then_with(|| {
                path_order(
                    entries[left.index].path.as_str(),
                    entries[right.index].path.as_str(),
                )
            })
    });
    ranked.into_iter().map(|entry| entry.index).collect()
}

// Path order as JavaScript sorts text, by UTF-16 units.
fn path_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

// The first ranked entries, up to the cap, whose real location lies strictly inside `root`, the
// working folder's own real location. A path that is gone or whose links never end is left out;
// any other failure fails the search.
fn contained_entries(
    entries: &[SessionFileSearchEntry],
    ranked: &[usize],
    folder: &Path,
    root: &Path,
) -> io::Result<Vec<SessionFileSearchEntry>> {
    let mut kept = Vec::new();
    for &index in ranked {
        if kept.len() == FILE_SEARCH_RESULT_MAX {
            break;
        }
        let entry = &entries[index];
        match real_path(&folder.join(entry.path.as_str())) {
            Ok(resolved) => {
                if resolved != root && resolved.starts_with(root) {
                    kept.push(entry.clone());
                }
            }
            Err(error) if is_gone(&error) || is_link_loop(&error) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceState};
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::session::methods::{
        SessionFileSearchEntry, SessionFileSearchEntryKind, SessionFileSearchRequest,
    };

    use super::{FILE_SEARCH_STATEMENT_CAPACITY, FileSearchError, FileSearchService};
    use crate::database::connection::read_pool::DatabaseReadPool;
    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use crate::git::process::{GitRunner, test_git_runner, write_link};
    use crate::session::directory::test_rows::insert_session_row;
    use crate::workspace::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

    /// A session whose working folder is `folder`, and the search over it; the writer is kept so
    /// the database stays open.
    struct Harness {
        _writer: DatabaseWriter,
        _database: TestDatabase,
        session_id: SessionId,
        service: FileSearchService,
    }

    async fn harness(git: GitRunner, folder: &Path) -> Harness {
        let database = TestDatabase::new();
        // Opening the writer creates the file with the daemon's schema.
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let session_id = test_session_id();
        let connection = database.reader();
        insert_session_row(&connection, session_id.text().as_str(), None, None);
        for row in project_and_mount_rows("mount", None) {
            connection
                .execute_batch(&row)
                .expect("the project and its mount are stored");
        }
        connection
            .execute(
                "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root,
                   state, created_at, updated_at)
                 VALUES ('workspace', ?1, 'mount', ?2, ?3, ?4, ?5, ?5)",
                rusqlite::params![
                    session_id.text().as_str(),
                    <&'static str>::from(ExecutionMode::BoundRoot),
                    folder.to_str().expect("a temporary folder's path is UTF-8"),
                    <&'static str>::from(WorkspaceState::Ready),
                    PARENT_ROWS_AT
                ],
            )
            .expect("the workspace is stored");
        let service = FileSearchService::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                FILE_SEARCH_STATEMENT_CAPACITY,
            )),
            git,
        );
        Harness {
            _writer: writer,
            _database: database,
            session_id,
            service,
        }
    }

    fn everything(session_id: SessionId) -> SessionFileSearchRequest {
        serde_json::from_value(json!({ "sessionId": session_id, "query": "" }))
            .expect("an empty query is a request")
    }

    // Killed by keeping a row whose real location leaves the folder (`starts_with` dropped) or
    // is the folder itself (the strict `!=` dropped).
    #[rstest]
    #[case::to_a_file_outside("escape", "../outside.txt")]
    #[case::to_the_folder_itself("itself", ".")]
    #[tokio::test]
    async fn file_search_drops_a_link_that_does_not_stay_inside_the_folder(
        #[case] link: &str,
        #[case] target: &str,
    ) {
        let git = test_git_runner();
        let root = tempfile::tempdir().expect("the temporary folder is made");
        let folder = root.path().join("folder");
        std::fs::create_dir(&folder).expect("the working folder is made");
        std::fs::write(folder.join("inside.txt"), "inside\n").expect("a file is written");
        std::fs::write(root.path().join("outside.txt"), "outside\n").expect("a file is written");
        write_link(&git, &root.path().join("links"), &folder, link, target).await;
        let harness = harness(git, &folder).await;

        let response = harness
            .service
            .search(everything(harness.session_id))
            .await
            .expect("the folder is searched");

        assert_eq!(
            response.entries,
            [SessionFileSearchEntry {
                path: FilesystemPath::new("inside.txt".to_owned()).expect("a path"),
                kind: SessionFileSearchEntryKind::File,
            }]
        );
    }

    // Killed by a working folder that is gone failing as a fault instead of answering the refusal
    // a client reads.
    #[tokio::test]
    async fn file_search_answers_working_folder_missing_for_a_folder_that_is_gone() {
        let root = tempfile::tempdir().expect("the temporary folder is made");
        let harness = harness(test_git_runner(), &root.path().join("gone")).await;

        let refused = harness.service.search(everything(harness.session_id)).await;

        let Err(FileSearchError::Refused(refusal)) = refused else {
            panic!("a folder that is gone is refused, not searched or failed: {refused:?}");
        };
        assert_eq!(refusal.code, RefusalCode::SessionWorkingFolderMissing);
    }
}
