//! The `@` search's tests: what a search answers, and how long a folder's listing is kept.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::repo::git_reads::WorkingTreeChangeMode;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{
    SessionFileSearchEntry, SessionFileSearchEntryKind, SessionFileSearchRequest,
    SessionFileSearchResponse,
};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::{PathRules, real_path};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_workspace::git::process::{GitRunner, test_git_runner, write_link};
use sidekicks_workspace::git::worktree::watch::{
    FOLDER_CHANGE_CAPACITY, FolderWatchChange, FolderWatchChangeKind,
};
use sidekicks_workspace::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};
use tokio::sync::broadcast;

use super::{FILE_SEARCH_STATEMENT_CAPACITY, FileSearchError, FileSearchService, lock_listings};
use crate::questions::schema::schema_parts;

/// Bounds a wait the test expects to end, so one that never does fails the test.
const WAIT: Duration = Duration::from_secs(10);

/// A file watch follows the folder's tree.
const WATCHED: FolderWatchChangeKind = FolderWatchChangeKind::Changed {
    mode: WorkingTreeChangeMode::Watch,
};

/// A session whose working folder is `folder`, the search over it, and the folder changes it
/// hears; the writer is kept so the database stays open.
struct Harness {
    _writer: DatabaseWriter,
    _database: TestDatabase,
    session_id: SessionId,
    service: FileSearchService,
    folder_changes: broadcast::Sender<FolderWatchChange>,
}

impl Harness {
    // Every file and folder the search answers, in its order.
    async fn search_paths(&self) -> Vec<String> {
        let response = self
            .service
            .search(everything(self.session_id))
            .await
            .expect("the folder is searched");
        paths_of(&response).into_iter().map(str::to_owned).collect()
    }

    // Tells the search `kind` of the folder at `key` and waits until it has read it.
    async fn tell(&self, key: &Path, kind: FolderWatchChangeKind) {
        self.folder_changes
            .send(FolderWatchChange {
                key: key.to_path_buf(),
                kind,
            })
            .expect("the search hears folder changes");
        self.until_heard().await;
    }

    // Waits until the search has read every folder change sent; on the test's one thread its
    // follower handles a change before it next waits.
    async fn until_heard(&self) {
        tokio::time::timeout(WAIT, async {
            while !self.folder_changes.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the search reads every folder change");
    }
}

async fn harness(git: GitRunner, folder: &Path) -> Harness {
    let database = TestDatabase::new(schema_parts());
    // Opening the writer creates the file with the daemon's schema.
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let session_id = test_session_id();
    let connection = database.reader();
    insert_session_row(&connection, session_id.text().as_str(), None, None);
    // The working-folder read takes the attached mount's id as one the daemon minted.
    let mount_id = mint_uuid_v7().to_string();
    for row in project_and_mount_rows(&mount_id, None) {
        connection
            .execute_batch(&row)
            .expect("the project and its mount are stored");
    }
    connection
        .execute(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root,
               state, created_at, updated_at)
             VALUES ('workspace', ?1, ?6, ?2, ?3, ?4, ?5, ?5)",
            rusqlite::params![
                session_id.text().as_str(),
                <&'static str>::from(ExecutionMode::BoundRoot),
                folder.to_str().expect("a temporary folder's path is UTF-8"),
                <&'static str>::from(WorkspaceState::Ready),
                PARENT_ROWS_AT,
                mount_id
            ],
        )
        .expect("the workspace is stored");
    let (folder_changes, heard) = broadcast::channel(FOLDER_CHANGE_CAPACITY);
    let service = FileSearchService::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            FILE_SEARCH_STATEMENT_CAPACITY,
        )),
        git,
        heard,
    );
    Harness {
        _writer: writer,
        _database: database,
        session_id,
        service,
        folder_changes,
    }
}

fn everything(session_id: SessionId) -> SessionFileSearchRequest {
    serde_json::from_value(json!({ "sessionId": session_id, "query": "" }))
        .expect("an empty query is a request")
}

// A folder holding `a.txt`, made in `root`.
fn folder_with_a_file(root: &Path) -> PathBuf {
    let folder = root.join("folder");
    std::fs::create_dir(&folder).expect("the working folder is made");
    std::fs::write(folder.join("a.txt"), "a\n").expect("a file is written");
    folder
}

// The key the watch gives `folder`: its resolved path in the system's comparable form.
fn watch_key(folder: &Path) -> PathBuf {
    let resolved = real_path(folder).expect("the folder resolves");
    PathRules::NATIVE
        .comparable_components(&resolved)
        .into_iter()
        .collect()
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

// The answer's paths, in its order.
fn paths_of(response: &SessionFileSearchResponse) -> Vec<&str> {
    response
        .entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect()
}

// Killed by a walk that runs only while a search waits on it (the dropped search's walk is
// never kept), by a follower that never drops a listing on a change, and by listings keyed by
// the folder as stored, here a link, instead of by its resolved path.
#[tokio::test]
async fn file_search_keeps_a_walk_no_search_waits_on_until_the_folder_changes() {
    let git = test_git_runner();
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let folder = folder_with_a_file(root.path());
    write_link(
        &git,
        &root.path().join("links"),
        root.path(),
        "linked",
        "folder",
    )
    .await;
    let linked = root.path().join("linked");
    let harness = harness(git, &linked).await;
    let key = watch_key(&folder);
    harness.tell(&key, WATCHED).await;

    // A search dropped once its walk began.
    drop(harness.service.listing_of(None, linked, key.clone()));
    tokio::time::timeout(WAIT, harness.service.stop())
        .await
        .expect("the walk ends with no search waiting on it");
    std::fs::write(folder.join("b.txt"), "b\n").expect("a file is written");
    let kept = harness.search_paths().await;
    harness.tell(&key, WATCHED).await;
    let fresh = harness.search_paths().await;

    assert_eq!(kept, ["a.txt"]);
    assert_eq!(fresh, ["a.txt", "b.txt"]);
}

// Killed by a lag the follower ignores, and by one that drops only the folder the changes
// it read named.
#[tokio::test]
async fn file_search_walks_again_once_the_folder_changes_outran_it() {
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let folder = folder_with_a_file(root.path());
    let harness = harness(test_git_runner(), &folder).await;
    let key = watch_key(&folder);
    harness.tell(&key, WATCHED).await;
    harness.search_paths().await;
    std::fs::write(folder.join("b.txt"), "b\n").expect("a file is written");
    let kept = harness.search_paths().await;

    // More changes than the channel holds, all sent before the follower reads any.
    for _ in 0..=FOLDER_CHANGE_CAPACITY {
        harness
            .folder_changes
            .send(FolderWatchChange {
                key: root.path().join("other"),
                kind: WATCHED,
            })
            .expect("the search hears folder changes");
    }
    harness.until_heard().await;
    let fresh = harness.search_paths().await;

    assert_eq!(kept, ["a.txt"]);
    assert_eq!(fresh, ["a.txt", "b.txt"]);
}

// Killed by a watch's end that leaves the folder's entry, so the map never shrinks.
#[tokio::test]
async fn file_search_forgets_a_folder_once_its_watch_ends() {
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let folder = folder_with_a_file(root.path());
    let harness = harness(test_git_runner(), &folder).await;
    let key = watch_key(&folder);
    harness.tell(&key, WATCHED).await;
    harness.search_paths().await;
    let was_kept = lock_listings(&harness.service.listings)
        .by_folder
        .get(&key)
        .is_some_and(|listings| listings.kept.is_some());

    harness.tell(&key, FolderWatchChangeKind::Unwatched).await;

    assert!(was_kept, "the watched folder's listing is kept");
    assert!(
        !lock_listings(&harness.service.listings)
            .by_folder
            .contains_key(&key),
        "the folder is forgotten once its watch ends"
    );
}

// Killed by a change whose mode is not read, which keeps the listing of a folder the slow tick
// follows, whose changes are told minutes late.
#[tokio::test]
async fn file_search_keeps_nothing_of_a_folder_on_the_slow_tick() {
    let root = tempfile::tempdir().expect("the temporary folder is made");
    let folder = folder_with_a_file(root.path());
    let harness = harness(test_git_runner(), &folder).await;
    let key = watch_key(&folder);
    let slow_tick = FolderWatchChangeKind::Changed {
        mode: WorkingTreeChangeMode::SlowTick,
    };
    harness.tell(&key, slow_tick).await;
    harness.search_paths().await;
    std::fs::write(folder.join("b.txt"), "b\n").expect("a file is written");

    assert_eq!(harness.search_paths().await, ["a.txt", "b.txt"]);
}
