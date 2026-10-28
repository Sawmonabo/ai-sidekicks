use std::error::Error;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use rusqlite::{OptionalExtension, params};
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::worktree::copy_progress::WorktreeCopy;
use sidekicks_contracts::worktree::lifecycle::{
    KeptWorktree, RemovedWorktreeId, WorktreeId, WorktreeRetireConflictDetails,
    WorktreeRetireRequest, WorktreeState,
};
use sidekicks_platforms::{
    DOES_HELD_FILE_REFUSE_RENAME, create_held_file, harness_test_name, scratch_volume,
};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;

use super::test_owner::{FolderSighting, RecordingOwner};
use super::{
    FolderProcessOwner, WorktreeRemoval, WorktreeRemovalDeps, WorktreeRemovalError,
    WorktreeSessionSweep, WorktreeSweep, new_removed_worktree_id,
};
use crate::git::process::{
    GitRunner, StartedFileWatch, find_git_executable, test_git_runner,
    test_git_runner_with_environment,
};
use crate::git::worktree::errors::WorktreeRefusal;
use crate::git::worktree::kept_copy::{
    KEPT_RECORD_ENTRY, KEPT_TREE_ENTRY, KeptCopyRowWrites, KeptCopyTools, WorktreeAside,
    move_worktree_aside,
};
use crate::git::worktree::occupancy::{MOUNT_OCCUPANCY_STATEMENT_CAPACITY, MountOccupancyReader};
use crate::git::worktree::reads::tree_name_of;
use crate::git::worktree::removed_store::kept_folder_for;
use crate::git::worktree::removed_store::rows::KeptWorktreeRecord;
use crate::git::worktree::removed_store::test_fixture::KeptCopyFixture;
use crate::git::worktree::rows::WorktreeRow;
use crate::git::worktree::service::cleanup::RetiredWorktreeKeeper;
use crate::git::worktree::test_rows::store_run_inside;

// A session sweep that records each tree it swept.
#[derive(Default)]
struct RecordingSweep {
    swept: Mutex<Vec<WorktreeId>>,
}

impl WorktreeSessionSweep for RecordingSweep {
    fn sweep_to_repo_root<'a>(
        &'a self,
        sweep: &'a WorktreeSweep,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            self.swept
                .lock()
                .expect("the sweep's list")
                .push(sweep.worktree_id);
            Ok(())
        })
    }
}

/// The kept worktrees' fixture with a removal over it, whose process owner and session sweep
/// record what they were asked.
pub(crate) struct RemovalFixture {
    /// The repository, its trees and the store.
    pub(crate) kept: KeptCopyFixture,
    /// The removal under test.
    pub(crate) removal: WorktreeRemoval,
    owner: Arc<RecordingOwner>,
    sessions: Arc<RecordingSweep>,
}

impl RemovalFixture {
    /// The fixture over a fresh repository, its git calls through the tests' runner.
    pub(crate) async fn new() -> Self {
        Self::over(KeptCopyFixture::new().await, test_git_runner())
    }

    /// The fixture over `kept`, the removal's git calls through `git`.
    pub(super) fn over(kept: KeptCopyFixture, git: GitRunner) -> Self {
        let owner = Arc::new(RecordingOwner::default());
        let sessions = Arc::new(RecordingSweep::default());
        let reads = Arc::new(DatabaseReadPool::new(
            kept.database.path(),
            MOUNT_OCCUPANCY_STATEMENT_CAPACITY,
        ));
        let removal = WorktreeRemoval::new(WorktreeRemovalDeps {
            git,
            worktrees: Arc::clone(&kept.worktrees),
            removed_worktrees: Arc::clone(&kept.store),
            occupancy: MountOccupancyReader::new(reads),
            process_owners: vec![Arc::clone(&owner) as Arc<dyn FolderProcessOwner>],
            sessions: Arc::clone(&sessions) as Arc<dyn WorktreeSessionSweep>,
            worktrees_folder: kept.worktrees_folder.clone(),
        });
        Self {
            kept,
            removal,
            owner,
            sessions,
        }
    }

    /// The trees whose sessions were swept, in order.
    pub(super) fn swept(&self) -> Vec<WorktreeId> {
        self.sessions
            .swept
            .lock()
            .expect("the sweep's list")
            .clone()
    }

    /// The tree's state on its row, as stored.
    pub(super) fn worktree_state(&self, tree: &WorktreeRow) -> String {
        self.kept
            .database
            .reader()
            .query_row(
                "SELECT state FROM worktrees WHERE id = ?1",
                [tree.id.to_string()],
                |row| row.get(0),
            )
            .expect("the tree's row is read")
    }

    /// Whether the kept copy's row is listed, or `None` without a row.
    pub(super) fn kept_copy_rows(&self, removed_worktree_id: &RemovedWorktreeId) -> Option<bool> {
        self.kept
            .database
            .reader()
            .query_row(
                "SELECT removed_at IS NOT NULL FROM removed_worktrees WHERE id = ?1",
                [removed_worktree_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .expect("the kept copy's row is read")
    }

    // The first kept copy's row, written or listed.
    fn first_kept_copy(&self) -> Option<RemovedWorktreeId> {
        self.kept
            .database
            .reader()
            .query_row(
                "SELECT id FROM removed_worktrees ORDER BY id LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .expect("the kept copies are read")
            .map(|id| RemovedWorktreeId::new(&id).expect("a stored kept copy id"))
    }

    /// A discard of `tree` a crash cut after its row named the record and before the tree moved:
    /// the kept folder holds only a part of what the copy makes.
    pub(super) async fn cut_before_move(&self, tree: &WorktreeRow) -> RemovedWorktreeId {
        let removed_worktree_id = new_removed_worktree_id();
        let kept_folder = kept_folder_for(tree, &removed_worktree_id);
        self.kept
            .store
            .pending_kept_copy(KeptWorktreeRecord {
                removed_worktree_id,
                worktree: tree.clone(),
                kept_folder: kept_folder.clone(),
            })
            .record_pending()
            .await
            .expect("the pending row is written");
        std::fs::create_dir_all(kept_folder.join(KEPT_RECORD_ENTRY))
            .expect("a part of the kept copy is made");
        // The row names the record together with the commit the tree was on, as the copy writes
        // them.
        let head_commit = self
            .kept
            .git(Path::new(tree.fs_root.as_str()), &["rev-parse", "HEAD"])
            .await;
        self.kept
            .database
            .reader()
            .execute(
                "UPDATE removed_worktrees SET record_folder = ?1, head_commit = ?3 WHERE id = ?2",
                params![
                    self.kept
                        .common_folder()
                        .join("worktrees")
                        .join(
                            Path::new(tree.fs_root.as_str())
                                .file_name()
                                .expect("a name")
                        )
                        .to_string_lossy(),
                    removed_worktree_id.to_string(),
                    head_commit.trim()
                ],
            )
            .expect("the row names the tree's record");
        removed_worktree_id
    }

    /// A discard of `tree` a crash cut after the tree moved aside and before its retirement was
    /// recorded; answers the kept copy and git's record of the tree.
    pub(super) async fn cut_after_move(&self, tree: &WorktreeRow) -> (RemovedWorktreeId, PathBuf) {
        let removed_worktree_id = new_removed_worktree_id();
        let kept_folder = kept_folder_for(tree, &removed_worktree_id);
        let tree_folder = PathBuf::from(tree.fs_root.as_str());
        let copy = WorktreeCopy::Removing {
            worktree_id: tree.id,
            project_id: ProjectId::new(&self.kept.mount).expect("the project's id"),
            name: tree_name_of(&tree_folder).expect("a tree's name"),
            copied_bytes: SafeInt::ZERO,
            total_bytes: SafeInt::ZERO,
        };
        let row_writes = self.kept.store.pending_kept_copy(KeptWorktreeRecord {
            removed_worktree_id,
            worktree: tree.clone(),
            kept_folder: kept_folder.clone(),
        });
        let moved = move_worktree_aside(
            KeptCopyTools {
                git: &self.kept.git,
                place: None,
                folder_moves: self.kept.store.folder_move_tools(),
            },
            WorktreeAside {
                tree_folder: &tree_folder,
                kept_folder: &kept_folder,
                removed_worktree_id: &removed_worktree_id,
                copy: &copy,
            },
            &row_writes,
        )
        .await
        .expect("the tree moves aside");
        (removed_worktree_id, moved.state.record_folder)
    }
}

fn retire_request(tree: &WorktreeRow, discard: bool) -> WorktreeRetireRequest {
    WorktreeRetireRequest {
        worktree_id: tree.id,
        discard,
    }
}

// Kills reading the tree for something to lose after ending its processes, skipping ignored
// files, and ending processes before the checks.
#[tokio::test]
async fn a_plain_removal_refuses_while_anything_could_be_lost_and_ends_nothing() {
    let fixture = RemovalFixture::new().await;
    let repository = fixture.kept.repository.clone();
    std::fs::write(repository.join(".gitignore"), ".env\n").expect("the ignore file is written");
    fixture.kept.git(&repository, &["add", ".gitignore"]).await;
    fixture.kept.commit(&repository, "ignore .env").await;
    // Every commit is pushed, so only the ignored file is there to lose.
    fixture
        .kept
        .git(
            &repository,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        )
        .await;
    let ignored = fixture.kept.add_tree("ignored", "ignored").await;
    std::fs::write(
        Path::new(ignored.fs_root.as_str()).join(".env"),
        "TOKEN=x\n",
    )
    .expect("the ignored file is written");
    let busy = fixture.kept.add_tree("busy", "busy").await;
    store_run_inside(
        &fixture.kept.database.reader(),
        &fixture.kept.mount,
        &repository,
        Path::new(busy.fs_root.as_str()),
    );

    match fixture
        .removal
        .retire(&retire_request(&ignored, false))
        .await
    {
        Err(WorktreeRemovalError::Refused(WorktreeRefusal::RetireConflict {
            details: WorktreeRetireConflictDetails::HasChanges { worktree_id, risks },
        })) => {
            assert_eq!(worktree_id, ignored.id);
            assert_eq!(risks.ignored_file_count.get(), 1, "the ignored file counts");
            assert_eq!(risks.uncommitted_file_count.get(), 0);
            assert_eq!(risks.unpushed_commit_count.get(), 0);
        }
        other => unreachable!("the removal was not refused for its ignored file: {other:?}"),
    }
    match fixture.removal.retire(&retire_request(&busy, true)).await {
        Err(WorktreeRemovalError::Refused(WorktreeRefusal::RetireConflict {
            details: WorktreeRetireConflictDetails::RootBusy { worktree_id, .. },
        })) => assert_eq!(worktree_id, busy.id),
        other => unreachable!("the removal was not refused for its run: {other:?}"),
    }

    assert!(
        fixture.owner.asked().is_empty(),
        "a refused removal ends nothing"
    );
    assert_eq!(
        fixture.worktree_state(&ignored),
        <&str>::from(WorktreeState::Ready)
    );
    assert_eq!(
        fixture.worktree_state(&busy),
        <&str>::from(WorktreeState::Ready)
    );
}

// Kills deleting the stop before the move, and copying the file watch's socket and cookie folder
// into the record copy.
#[tokio::test]
async fn a_discard_stops_the_file_watch_in_the_tree_before_it_moves() {
    let scratch = tempfile::tempdir().expect("a scratch folder for git's trace");
    let trace = scratch.path().join("trace.json");
    let git = test_git_runner_with_environment(&[(
        "GIT_TRACE2_EVENT",
        trace.to_str().expect("the scratch folder's path is text"),
    )]);
    let fixture = RemovalFixture::over(KeptCopyFixture::new().await, git);
    if !fixture
        .kept
        .git
        .has_built_in_file_watch(None)
        .await
        .expect("git reads whether it watches files")
    {
        return;
    }
    let tree = fixture.kept.add_tree("watched", "watched").await;
    let folder = PathBuf::from(tree.fs_root.as_str());
    let environment: Vec<(String, String)> = std::env::vars().collect();
    let _started = StartedFileWatch {
        git: find_git_executable(&environment).expect("the tests run where git is"),
        folder: folder.clone(),
    };
    fixture
        .kept
        .git(&folder, &["fsmonitor--daemon", "start"])
        .await;

    let response = fixture
        .removal
        .retire(&retire_request(&tree, true))
        .await
        .expect("the discard succeeds");

    let removed_worktree_id = response
        .kept
        .expect("the discard keeps a copy")
        .removed_worktree_id;
    let record_copy = fixture
        .kept
        .kept_folder(&removed_worktree_id)
        .join(KEPT_RECORD_ENTRY);
    assert!(record_copy.exists(), "the record is copied");
    assert!(
        !record_copy.join("fsmonitor--daemon").exists()
            && !record_copy.join("fsmonitor--daemon.ipc").exists(),
        "the record copy holds none of the file watch's entries"
    );
    let stop = format!(
        r#""-C",{},"-c","fsmonitor.allowRemote=true","fsmonitor--daemon","stop"]"#,
        serde_json::to_string(&folder.to_string_lossy()).expect("a path is JSON text")
    );
    let trace = std::fs::read_to_string(&trace).expect("git's trace reads");
    assert!(
        trace
            .lines()
            .any(|event| event.contains(r#""event":"start""#) && event.contains(&stop)),
        "the file watch is stopped in the tree's own folder, before it moves"
    );
}

// Kills ending the tree's processes after its move, and dropping their hold before the move, which
// lets a process start in the tree again before it leaves.
#[tokio::test]
async fn a_discard_ends_the_tree_s_processes_in_place_and_holds_them_off_until_it_moves() {
    let fixture = RemovalFixture::new().await;
    let tree = fixture.kept.add_tree("held", "held").await;
    let folder = PathBuf::from(tree.fs_root.as_str());

    fixture
        .removal
        .retire(&retire_request(&tree, true))
        .await
        .expect("the discard succeeds");

    assert_eq!(
        fixture.owner.asked(),
        [FolderSighting {
            folder: folder.clone(),
            was_present: true,
        }],
        "the owner is asked for the tree's folder while it is in place"
    );
    assert_eq!(
        fixture.owner.released(),
        [FolderSighting {
            folder,
            was_present: false,
        }],
        "the hold drops only once the tree has moved"
    );
}

// Kills two removals of one tree run side by side, where the second reads the tree live and moves
// a folder the first has already moved.
#[tokio::test]
async fn the_second_of_two_discards_pressed_together_answers_the_tree_retired() {
    let fixture = RemovalFixture::new().await;
    let tree = fixture.kept.add_tree("twice", "twice").await;
    let request = retire_request(&tree, true);

    let (first, second) = tokio::join!(
        fixture.removal.retire(&request),
        fixture.removal.retire(&request)
    );

    let mut kept: Vec<Option<KeptWorktree>> = [first, second]
        .into_iter()
        .map(|answer| answer.expect("both discards answer").kept)
        .collect();
    kept.sort_by_key(Option::is_none);
    assert!(
        matches!(kept[..], [Some(_), None]),
        "one discard keeps the tree and the other finds it retired, got {kept:?}"
    );
}

// Kills running the move and its record outside a task of their own, where a caller that stops
// waiting cuts it part way, and a tree's turn or process holds dropped with that caller, which lets
// a second removal in and a process start in the folder before the tree moves.
#[tokio::test]
async fn a_discard_whose_caller_stops_waiting_mid_move_lands_whole() {
    let fixture = RemovalFixture::new().await;
    let tree = fixture.kept.add_tree("cut", "cut").await;
    let request = retire_request(&tree, true);
    // Boxed, so dropping it drops the call, as a caller that stops waiting does.
    let mut retiring = Box::pin(fixture.removal.retire(&request));
    // Polled until the kept copy's row is written, which only the move under the lock does.
    let removed_worktree_id = loop {
        if let Some(removed_worktree_id) = fixture.first_kept_copy() {
            break removed_worktree_id;
        }
        assert!(
            futures::poll!(retiring.as_mut()).is_pending(),
            "the discard ended before its kept copy's row could be seen"
        );
        tokio::task::yield_now().await;
    };
    drop(retiring);
    assert!(
        fixture
            .removal
            .shared
            .retirements
            .try_acquire(tree.id)
            .is_err(),
        "the tree's turn is held while the move runs"
    );
    assert!(
        fixture.owner.released().is_empty(),
        "the folder's processes are held off while the move runs"
    );

    // The key is free only once the held work has ended.
    drop(
        fixture
            .kept
            .store
            .kept_copy_lock()
            .acquire(removed_worktree_id)
            .await,
    );
    drop(fixture.removal.shared.retirements.acquire(tree.id).await);
    assert_eq!(
        fixture.owner.released(),
        [FolderSighting {
            folder: PathBuf::from(tree.fs_root.as_str()),
            was_present: false,
        }],
        "the hold drops only once the tree has moved"
    );

    assert_eq!(
        fixture.kept_copy_rows(&removed_worktree_id),
        Some(true),
        "the copy is listed"
    );
    assert_eq!(
        fixture.worktree_state(&tree),
        <&str>::from(WorktreeState::Retired)
    );
    assert!(
        !Path::new(tree.fs_root.as_str()).exists(),
        "the tree has moved"
    );
    assert!(
        fixture
            .kept
            .kept_folder(&removed_worktree_id)
            .join(KEPT_TREE_ENTRY)
            .join(".git")
            .exists(),
        "the tree is kept whole"
    );
}

// Kills a keeping aside whose tree's turn or process holds drop with a caller that stops waiting
// mid-move, which lets a second removal of the tree in and a process start in its folder before
// it moves.
#[tokio::test]
async fn a_keeping_aside_whose_caller_stops_waiting_holds_the_tree_s_turn_until_it_moves() {
    let fixture = RemovalFixture::new().await;
    let tree = fixture.kept.add_tree("kept", "kept").await;
    let folder = PathBuf::from(tree.fs_root.as_str());
    fixture
        .removal
        .retire(&retire_request(&tree, false))
        .await
        .expect("the plain removal succeeds");
    let released_before = fixture.owner.released().len();
    let process_holds = vec![
        fixture
            .owner
            .end_processes_in_folder(&folder)
            .await
            .expect("the owner ends its processes"),
    ];
    // Boxed, so dropping it drops the call, as a cleanup that stops waiting does.
    let mut keeping = Box::pin(fixture.removal.keep_retired_aside(&tree, process_holds));
    let removed_worktree_id = loop {
        if let Some(removed_worktree_id) = fixture.first_kept_copy() {
            break removed_worktree_id;
        }
        assert!(
            futures::poll!(keeping.as_mut()).is_pending(),
            "the keeping aside ended before its kept copy's row could be seen"
        );
        tokio::task::yield_now().await;
    };
    drop(keeping);
    assert!(
        fixture
            .removal
            .shared
            .retirements
            .try_acquire(tree.id)
            .is_err(),
        "the tree's turn is held while the move runs"
    );
    assert_eq!(
        fixture.owner.released().len(),
        released_before,
        "the folder's processes are held off while the move runs"
    );

    drop(
        fixture
            .kept
            .store
            .kept_copy_lock()
            .acquire(removed_worktree_id)
            .await,
    );
    drop(fixture.removal.shared.retirements.acquire(tree.id).await);
    assert_eq!(
        fixture.owner.released()[released_before..],
        [FolderSighting {
            folder,
            was_present: false,
        }],
        "the hold drops only once the tree has moved"
    );
}

// Kills losing the copy across volumes: a discard whose kept folder is on another volume lists the
// copy and removes the original.
#[tokio::test]
async fn a_discard_across_volumes_lists_the_copy_and_removes_the_original() {
    let Some(volume) = scratch_volume(
        &harness_test_name(
            module_path!(),
            "a_discard_across_volumes_lists_the_copy_and_removes_the_original",
        ),
        Path::new("worktrees/app/.removed"),
    ) else {
        return;
    };
    let fixture = RemovalFixture::over(
        KeptCopyFixture::in_folder(volume.root()).await,
        test_git_runner(),
    );
    let tree = fixture.kept.add_tree("crossing", "crossing").await;

    let response = fixture
        .removal
        .retire(&retire_request(&tree, true))
        .await
        .expect("the discard across volumes succeeds");

    let removed_worktree_id = response
        .kept
        .expect("the discard keeps a copy")
        .removed_worktree_id;
    assert_eq!(
        fixture.kept_copy_rows(&removed_worktree_id),
        Some(true),
        "the copy is listed"
    );
    assert!(
        !Path::new(tree.fs_root.as_str()).exists(),
        "the original is gone"
    );
    assert!(
        fixture
            .kept
            .kept_folder(&removed_worktree_id)
            .join(KEPT_TREE_ENTRY)
            .join(".git")
            .exists(),
        "the copy is whole"
    );
    assert_eq!(fixture.swept(), vec![tree.id]);
}

// Kills answering a move a program's open file refused as an internal failure, and moving a tree
// part way where the system refuses the rename.
#[tokio::test]
async fn a_discard_of_a_tree_a_program_holds_open_is_refused_where_the_system_refuses_the_move() {
    let fixture = RemovalFixture::new().await;
    let tree = fixture.kept.add_tree("held", "held").await;
    let folder = PathBuf::from(tree.fs_root.as_str());
    let (_held, _) = create_held_file(|| {
        let path = folder.join(format!("held-{}.log", mint_uuid_v7()));
        Ok((File::create_new(&path)?, path))
    })
    .expect("a file in the tree is held open");

    let retired = fixture.removal.retire(&retire_request(&tree, true)).await;

    if DOES_HELD_FILE_REFUSE_RENAME {
        match retired {
            Err(WorktreeRemovalError::Refused(WorktreeRefusal::RetireFolderHeld {
                worktree_id,
                ..
            })) => assert_eq!(worktree_id, tree.id),
            other => unreachable!("the held tree's discard was not refused: {other:?}"),
        }
        assert!(folder.join(".git").exists(), "the tree stays where it was");
        assert_eq!(
            fixture.worktree_state(&tree),
            <&str>::from(WorktreeState::Ready)
        );
        assert_eq!(fixture.first_kept_copy(), None, "no kept copy is left");
        assert!(fixture.swept().is_empty(), "nothing is swept");
    } else {
        let response = retired.expect("the discard succeeds where the system lets it move");
        assert!(response.kept.is_some(), "the discard keeps a copy");
        assert!(!folder.exists(), "the tree has moved");
    }
}
