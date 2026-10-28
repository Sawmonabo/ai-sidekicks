//! `session.file.search`, the `@` search: the session's working folder listed, ranked by the
//! product's one fuzzy scorer with an entry's own name before its path, and cut to a fixed count.
//! A row whose real location is not strictly inside the working folder is dropped, so no answer
//! follows a link out of it or back to the folder itself. A folder is walked on a task of its own
//! that runs to its end whether or not a search still waits, and every search shares the walk under
//! way. A walk is kept, by the folder's resolved path, only while the working-folder watch follows
//! the folder's tree by a file watch, which tells each change at once, and until the watch tells of
//! a change or of its end; a folder the slow tick follows, or none, is walked for each search. Per
//! folder at most one walk runs and one more waits to follow a change, and the kept listings hold
//! at most 32 MiB together, the least recently searched dropped first. Ranking and the real
//! locations run off the runtime.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use futures::FutureExt as _;
use futures::future::{BoxFuture, Shared};
use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::WorkingTreeChangeMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{
    SessionFileSearchEntry, SessionFileSearchEntryKind, SessionFileSearchRequest,
    SessionFileSearchResponse,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::{PathRules, is_link_loop, real_path};
use sidekicks_search::ranking::score_subsequence;
use sidekicks_std::missing_entry::is_gone;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_workspace::git::process::{GitError, GitRunner};
use sidekicks_workspace::git::worktree::watch::{FolderWatchChange, FolderWatchChangeKind};
use sidekicks_workspace::working_folder::{WorkingFolderReadError, read_working_folder};
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use tokio::task::JoinError;
use tokio_util::task::TaskTracker;

use crate::search::files::listing::{ListingError, WorkingFolderListing, list_working_folder};

/// The statements the file search prepares on a read connection: the session's working folder.
pub const FILE_SEARCH_STATEMENT_CAPACITY: usize = 1;

/// The most rows one `@` search answers.
const FILE_SEARCH_RESULT_MAX: usize = 50;

// The most bytes the kept listings hold together: about three listings of 100,000 files.
const KEPT_LISTINGS_BYTE_CAP: usize = 32 * 1024 * 1024;

/// A working folder's rows as the searches share them, and how many files they were drawn from.
struct FolderCandidates {
    /// Every listed file and folder whose path a row can carry, in listing order.
    entries: Vec<SessionFileSearchEntry>,
    /// The files listed, those no row can carry among them.
    searched_file_count: usize,
    /// The files no row can carry: a name that is not UTF-8 or a path the row's type refuses.
    dropped_file_count: usize,
}

impl FolderCandidates {
    // The bytes the rows hold: each row and its path's text.
    fn byte_size(&self) -> usize {
        let path_bytes: usize = self
            .entries
            .iter()
            .map(|entry| entry.path.as_str().len())
            .sum();
        self.entries.len() * size_of::<SessionFileSearchEntry>() + path_bytes
    }
}

/// One working folder's walk, under way or done, which every search of the folder shares.
type SharedListing = Shared<BoxFuture<'static, Result<Arc<FolderCandidates>, ListingFailure>>>;

/// Why a shared listing gave no rows: the listing failed, or its task ended before it answered.
#[derive(Clone, Debug)]
enum ListingFailure {
    Listing(Arc<ListingError>),
    Task(Arc<JoinError>),
}

/// A folder's newest walk.
struct FolderWalk {
    /// Tells this walk from every other.
    id: u64,
    listing: SharedListing,
    /// The folder's change count when the walk began reading the folder; `None` while it waits
    /// for the walk before it to end.
    began_at_change: Option<u64>,
}

/// What the service holds of one working folder.
#[derive(Default)]
struct FolderListings {
    /// Whether the watch follows the folder's tree by a file watch, so a walk of it can be kept.
    is_watched: bool,
    /// The changes the watch has told of the folder; a walk begun before the last is stale.
    change_count: u64,
    walk: Option<FolderWalk>,
    /// The newest walk's size and its last search, once it is kept.
    kept: Option<KeptListing>,
}

/// A kept listing's size and the search that last read it.
struct KeptListing {
    bytes: usize,
    last_searched: u64,
}

/// Every working folder's walks and kept listings, by the folder's key.
#[derive(Default)]
struct KeptListings {
    next_walk_id: u64,
    /// Counts the searches, which tells the least recently searched kept listing.
    search_count: u64,
    /// The bytes every kept listing holds together.
    kept_bytes: usize,
    by_folder: HashMap<PathBuf, FolderListings>,
}

impl KeptListings {
    // A change the watch told: a kept listing of the folder goes, and a walk under way is stale.
    fn take_change(&mut self, change: FolderWatchChange) {
        let FolderWatchChange { key, kind } = change;
        let folder = self.by_folder.entry(key.clone()).or_default();
        folder.change_count += 1;
        folder.is_watched = match kind {
            FolderWatchChangeKind::Changed {
                mode: WorkingTreeChangeMode::Watch,
            } => true,
            FolderWatchChangeKind::Changed {
                mode: WorkingTreeChangeMode::SlowTick,
            }
            | FolderWatchChangeKind::Unwatched => false,
        };
        self.drop_kept(&key);
        self.forget_if_idle(&key);
    }

    // A change was missed, which may be any folder's, so nothing of any folder is trusted.
    fn forget_every_folder(&mut self) {
        self.by_folder.clear();
        self.kept_bytes = 0;
    }

    // Drops the folder's kept listing, so its next search walks it again.
    fn drop_kept(&mut self, key: &Path) {
        if let Some(folder) = self.by_folder.get_mut(key)
            && let Some(kept) = folder.kept.take()
        {
            self.kept_bytes -= kept.bytes;
            folder.walk = None;
        }
    }

    // Forgets a folder with no walk that no file watch follows, so the map shrinks with the watch.
    fn forget_if_idle(&mut self, key: &Path) {
        if self
            .by_folder
            .get(key)
            .is_some_and(|folder| folder.walk.is_none() && !folder.is_watched)
        {
            self.by_folder.remove(key);
        }
    }

    // Marks where the folder's walk `id` began reading it, against the changes told so far.
    fn begin_walk(&mut self, key: &Path, id: u64) {
        if let Some(folder) = self.by_folder.get_mut(key) {
            let change_count = folder.change_count;
            if let Some(walk) = folder.walk.as_mut().filter(|walk| walk.id == id) {
                walk.began_at_change = Some(change_count);
            }
        }
    }

    // Keeps the folder's walk `id` once it has listed `listed`, when it is still the folder's
    // newest walk, no change came since it began, a file watch follows the folder and it fits the
    // cap; else lets it go, so the next search walks again. Room for it is made by dropping the
    // least recently searched kept listings.
    fn settle_walk(&mut self, key: &Path, id: u64, listed: Option<&FolderCandidates>) {
        let last_searched = self.search_count;
        let Some(folder) = self.by_folder.get_mut(key) else {
            return;
        };
        let Some(walk) = folder.walk.as_ref().filter(|walk| walk.id == id) else {
            return;
        };
        let is_current = walk.began_at_change == Some(folder.change_count);
        let kept_bytes = listed
            .map(FolderCandidates::byte_size)
            .filter(|&bytes| is_current && folder.is_watched && bytes <= KEPT_LISTINGS_BYTE_CAP);
        let Some(bytes) = kept_bytes else {
            folder.walk = None;
            self.forget_if_idle(key);
            return;
        };
        folder.kept = Some(KeptListing {
            bytes,
            last_searched,
        });
        self.kept_bytes += bytes;
        while self.kept_bytes > KEPT_LISTINGS_BYTE_CAP {
            let least_recent = self
                .by_folder
                .iter()
                .filter(|(other, _)| other.as_path() != key)
                .filter_map(|(other, folder)| {
                    folder.kept.as_ref().map(|kept| (kept.last_searched, other))
                })
                .min()
                .map(|(_, other)| other.clone());
            let Some(least_recent) = least_recent else {
                break;
            };
            self.drop_kept(&least_recent);
            self.forget_if_idle(&least_recent);
        }
    }

    // Lets the folder's walk `id` go when it ended without settling, so the next search walks
    // again.
    fn abandon_walk(&mut self, key: &Path, id: u64) {
        if let Some(folder) = self.by_folder.get_mut(key)
            && folder.walk.as_ref().is_some_and(|walk| walk.id == id)
        {
            folder.walk = None;
            self.forget_if_idle(key);
        }
    }
}

/// Lets a walk go when its task ends without settling it, a panic or a stop among the ways.
struct UnsettledWalk {
    listings: Arc<Mutex<KeptListings>>,
    key: PathBuf,
    id: u64,
    is_settled: bool,
}

impl UnsettledWalk {
    // The walk has listed: it is kept or let go by what it listed.
    fn settle(&mut self, listed: Option<&FolderCandidates>) {
        self.is_settled = true;
        lock_listings(&self.listings).settle_walk(&self.key, self.id, listed);
    }
}

impl Drop for UnsettledWalk {
    fn drop(&mut self) {
        if !self.is_settled {
            lock_listings(&self.listings).abandon_walk(&self.key, self.id);
        }
    }
}

/// Why a file search was refused or failed.
#[derive(Debug, thiserror::Error)]
pub enum FileSearchError {
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
    /// The task that listed the working folder ended before it answered.
    #[error("the listing of the session's working folder did not finish")]
    ListingTask(#[source] Arc<JoinError>),
    /// A path's real location could not be read for a reason other than its being gone.
    #[error("a listed path's real location could not be read")]
    Resolve(#[source] io::Error),
    /// The blocking task that ranked the rows and read their real locations did not finish.
    #[error("the ranking of the listed paths did not finish")]
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
            | FileSearchError::ListingTask(_)
            | FileSearchError::Resolve(_)
            | FileSearchError::ResolveTask(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// Answers `session.file.search` over each session's working folder.
pub struct FileSearchService {
    pool: Arc<DatabaseReadPool>,
    git: GitRunner,
    /// Each working folder's walks and kept listing, and what the watch told of it.
    listings: Arc<Mutex<KeptListings>>,
    /// Every walk's task, so the stop waits for each.
    listing_tasks: TaskTracker,
}

impl FileSearchService {
    /// The search reading each session's working folder through `pool` and listing it through
    /// `git`, keeping a folder's listing by what the working-folder watch tells on
    /// `folder_changes` until that channel closes.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        git: GitRunner,
        folder_changes: broadcast::Receiver<FolderWatchChange>,
    ) -> Self {
        let listings = Arc::new(Mutex::new(KeptListings::default()));
        tokio::spawn(follow_folder_changes(
            Arc::downgrade(&listings),
            folder_changes,
        ));
        Self {
            pool,
            git,
            listings,
            listing_tasks: TaskTracker::new(),
        }
    }

    /// Settles once every walk under way has ended.
    pub async fn stop(&self) {
        self.listing_tasks.close();
        self.listing_tasks.wait().await;
    }

    /// The best matching files and folders, each path relative to the working folder, at most
    /// 50. Refused `session.notFound` for an unknown session and `session.workingFolder.missing`
    /// for a working folder that is not in place; fails with `Git` for a session in a WSL 2
    /// distribution, and as the folder's read, its listing or a path's real location fails.
    pub async fn search(
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
        // The watch's key for the folder: its resolved path in the system's comparable form.
        let key = PathRules::NATIVE
            .comparable_components(&root)
            .into_iter()
            .collect();
        let candidates = self
            .listing_of(working_folder.place, folder.clone(), key)
            .await
            .map_err(|failure| match failure {
                ListingFailure::Listing(error) => FileSearchError::Listing(error),
                ListingFailure::Task(error) => FileSearchError::ListingTask(error),
            })?;
        if candidates.dropped_file_count > 0 {
            tracing::warn!(
                session_id = session_id.text().as_str(),
                dropped_file_count = candidates.dropped_file_count,
                "the file search left out files whose names no row can carry"
            );
        }
        let searched_file_count = candidates.searched_file_count;
        let query = request.query;
        let entries = tokio::task::spawn_blocking(move || {
            let ranked = ranked_entries(&candidates.entries, query.as_str());
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

    // The folder's kept listing, else its walk under way when no change came since it began,
    // else a new walk, which waits for a stale walk under way to end first. A walk runs on a task
    // of its own to its end whether or not a search still waits. It is spawned under the map's
    // lock: its guard, which locks the map, is made only once the task runs, so a runtime shutting
    // down that drops the task here locks nothing.
    fn listing_of(&self, place: Option<Place>, folder: PathBuf, key: PathBuf) -> SharedListing {
        let mut listings = lock_listings(&self.listings);
        listings.search_count += 1;
        let search_count = listings.search_count;
        let id = listings.next_walk_id;
        let folder_listings = listings.by_folder.entry(key.clone()).or_default();
        if let (Some(kept), Some(walk)) = (&mut folder_listings.kept, &folder_listings.walk) {
            kept.last_searched = search_count;
            return walk.listing.clone();
        }
        let previous = match &folder_listings.walk {
            Some(walk)
                if walk
                    .began_at_change
                    .is_none_or(|began| began == folder_listings.change_count) =>
            {
                return walk.listing.clone();
            }
            Some(stale) => Some(stale.listing.clone()),
            None => None,
        };
        let task = self.listing_tasks.spawn(walk_folder(
            Arc::clone(&self.listings),
            self.git.clone(),
            place,
            folder,
            key,
            id,
            previous,
        ));
        let listing = async move {
            task.await
                .unwrap_or_else(|error| Err(ListingFailure::Task(Arc::new(error))))
        }
        .boxed()
        .shared();
        folder_listings.walk = Some(FolderWalk {
            id,
            listing: listing.clone(),
            began_at_change: None,
        });
        listings.next_walk_id += 1;
        listing
    }
}

// Walks the folder `folder`, keyed `key`, once the walk before it, `previous`, has ended, and keeps
// or lets go of what it listed.
async fn walk_folder(
    listings: Arc<Mutex<KeptListings>>,
    git: GitRunner,
    place: Option<Place>,
    folder: PathBuf,
    key: PathBuf,
    id: u64,
    previous: Option<SharedListing>,
) -> Result<Arc<FolderCandidates>, ListingFailure> {
    let mut unsettled = UnsettledWalk {
        listings,
        key,
        id,
        is_settled: false,
    };
    if let Some(previous) = previous {
        // The walk before answers its own searches, its failure among them; this one only waits
        // for its end, so no two walks of the folder run at once.
        drop(previous.await);
    }
    lock_listings(&unsettled.listings).begin_walk(&unsettled.key, id);
    let listed = list_working_folder(&git, place.as_ref(), &folder)
        .await
        .map(|listing| Arc::new(candidates_of(listing)))
        .map_err(|error| ListingFailure::Listing(Arc::new(error)));
    unsettled.settle(listed.as_deref().ok());
    listed
}

// Applies each change the working-folder watch tells to the kept listings, until the watch or the
// service is gone.
async fn follow_folder_changes(
    listings: Weak<Mutex<KeptListings>>,
    mut folder_changes: broadcast::Receiver<FolderWatchChange>,
) {
    loop {
        let received = folder_changes.recv().await;
        let Some(held) = listings.upgrade() else {
            return;
        };
        let mut folders = lock_listings(&held);
        match received {
            Ok(change) => folders.take_change(change),
            Err(RecvError::Lagged(_missed)) => folders.forget_every_folder(),
            Err(RecvError::Closed) => return,
        }
    }
}

fn lock_listings(listings: &Mutex<KeptListings>) -> MutexGuard<'_, KeptListings> {
    // The map holds no invariant a panicking holder could break.
    lock(listings)
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
        let (is_name_match, matched) =
            if let Some(matched) = score_subsequence(&candidate_units, &query_units) {
                (true, Some(matched))
            } else {
                candidate_units.clear();
                candidate_units.extend(path.encode_utf16());
                (false, score_subsequence(&candidate_units, &query_units))
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
mod tests;
