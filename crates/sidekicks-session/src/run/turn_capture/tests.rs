use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::run::turn_end::{ProviderTurnEnd, TurnOutcome};
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::data_folder::session_storage_folder;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;
use sidekicks_workspace::git::process::test_repository::make_test_repository;
use sidekicks_workspace::git::process::{GitCall, GitRunner, test_git_runner};
use sidekicks_workspace::git::turn_snapshot::capture::GitFloorReports;
use sidekicks_workspace::git::turn_snapshot::repack::CapturePacking;
use sidekicks_workspace::git::turn_snapshot::service::{
    TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY, TurnSnapshotService,
};
use sidekicks_workspace::git::worktree::test_rows::{RunContextRow, insert_worktree_rows};
use tempfile::TempDir;

use super::{TURN_CAPTURE_STATEMENT_CAPACITY, TurnCapture};
use crate::checkpoints::schema::schema_parts;
use crate::run::engine::RunEngine;
use crate::run::engine::test_fixture::{insert_run, test_engine};
use crate::run::engine::undo::RunCut;
use crate::run::state_change::RunWriteCompanions;

/// A run of its own session in a repository whose execution root is a folder below its checkout,
/// with a top-level file and one in that folder, the engine that writes its turns and the
/// snapshot service a capture records through.
struct Fixture {
    database: TestDatabase,
    log: TestLog,
    engine: Arc<RunEngine>,
    git: GitRunner,
    snapshots: Arc<TurnSnapshotService>,
    session_id: SessionId,
    run_id: RunId,
    data_folder: PathBuf,
    _root: TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().expect("the test makes its folder");
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let engine = test_engine(&database, Arc::clone(&log.service), root.path());
        let git = test_git_runner();
        let repository = make_test_repository(&git, root.path(), "repository").await;
        std::fs::create_dir(repository.join("pkg")).expect("the test makes the nested folder");
        std::fs::write(repository.join("notes.txt"), "a note\n").expect("the file is written");
        std::fs::write(repository.join("pkg").join("main.rs"), "fn main() {}\n")
            .expect("the nested file is written");
        let session_id = minted_session_id();
        let run_id = minted_run_id();
        insert_run(&database, session_id, run_id, "running");
        let rows = database.reader();
        insert_worktree_rows(&rows);
        let run_key = run_id.to_string();
        let execution_root = repository.join("pkg");
        let git_common_dir = repository.join(".git");
        RunContextRow {
            run_id: &run_key,
            execution_root: utf8(&execution_root),
            checkout_root: Some(utf8(&repository)),
            git_common_dir: Some(utf8(&git_common_dir)),
            ..RunContextRow::BOUND_ROOT
        }
        .insert(&rows)
        .expect("the test stores the run's context");
        let floor_reports = Arc::new(GitFloorReports::default());
        let snapshots = Arc::new(TurnSnapshotService::new(
            git.clone(),
            Arc::new(DatabaseReadPool::new(
                database.path(),
                TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY,
            )),
            Arc::new(KeyedLock::new()),
            Arc::new(CapturePacking::new(git.clone(), Arc::clone(&floor_reports))),
            floor_reports,
        ));
        Self {
            data_folder: root.path().join("data"),
            database,
            log,
            engine,
            git,
            snapshots,
            session_id,
            run_id,
            _root: root,
        }
    }

    // A capture over the fixture's database, as a daemon's start builds one.
    fn capture(&self) -> Arc<TurnCapture> {
        Arc::new(TurnCapture::new(
            Arc::new(DatabaseReadPool::new(
                self.database.path(),
                TURN_CAPTURE_STATEMENT_CAPACITY,
            )),
            Arc::new(|_: &SessionId| None),
            Arc::clone(&self.snapshots),
            self.data_folder.clone(),
        ))
    }

    async fn start_turn(&self, run_id: RunId) {
        self.engine
            .start_turn(run_id, None, None, None, None)
            .await
            .expect("the turn's start is written")
            .expect("the run is live");
    }

    async fn end_turn(&self, run_id: RunId, turn_number: u64) {
        let turn_number = SafeInt::new(turn_number).expect("the test's turns are safe integers");
        let written = self
            .engine
            .record_turn_end(
                run_id,
                ProviderTurnEnd {
                    turn_number,
                    outcome: TurnOutcome::Completed,
                },
            )
            .await
            .expect("the turn's end is written")
            .log_resend_failure(run_id);
        assert!(written, "the turn's end is no duplicate");
    }

    // The session's one capture folder, which a capture made.
    fn capture_folder(&self) -> PathBuf {
        let captures = session_storage_folder(&self.data_folder, &self.session_id).join("captures");
        let mut folders = std::fs::read_dir(&captures)
            .expect("a capture made the session's capture folder")
            .map(|entry| entry.expect("the entry reads").path())
            .collect::<Vec<_>>();
        assert_eq!(folders.len(), 1, "one repository was captured: {folders:?}");
        folders.remove(0)
    }

    // What git printed for `arguments` against the session's capture folder.
    async fn read_captures(&self, arguments: &[&str]) -> String {
        let call = GitCall::read(
            [OsString::from("--git-dir"), self.capture_folder().into()]
                .into_iter()
                .chain(arguments.iter().map(OsString::from)),
        );
        let output = self
            .git
            .run(None, call)
            .await
            .expect("git reads the captures");
        String::from_utf8(output.stdout).expect("git answers in UTF-8")
    }

    // The run's snapshot refs, in name order.
    async fn snapshot_refs(&self) -> Vec<String> {
        let prefix = format!("refs/sidekicks/runs/{}/", self.run_id);
        let listing = self
            .read_captures(&["for-each-ref", "--format=%(refname)", prefix.as_str()])
            .await;
        listing.lines().map(str::to_owned).collect()
    }

    fn snapshot_ref(&self, epoch: u64, turn: u64) -> String {
        format!(
            "refs/sidekicks/runs/{}/epoch-{epoch}/turn-{turn}",
            self.run_id
        )
    }
}

fn minted_session_id() -> SessionId {
    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
}

fn minted_run_id() -> RunId {
    RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
}

fn utf8(path: &Path) -> &str {
    path.to_str().expect("the temporary folder's path is UTF-8")
}

// Killed by a capture that does not follow turn ends, by one that captures from the execution
// root instead of the checkout root (the top-level file goes missing), by one that numbers the
// turn other than where the log stands, and by one that captures a run with no execution context,
// which makes that session's storage folder.
#[tokio::test]
async fn a_turn_end_captures_the_whole_checkout_and_a_run_without_a_checkout_captures_nothing() {
    let fixture = Fixture::new().await;
    let chat_session_id = minted_session_id();
    let chat_run_id = minted_run_id();
    insert_run(&fixture.database, chat_session_id, chat_run_id, "running");
    let capturing = fixture.capture().start(&fixture.log.followers);

    fixture.start_turn(fixture.run_id).await;
    fixture.end_turn(fixture.run_id, 1).await;
    fixture.start_turn(chat_run_id).await;
    fixture.end_turn(chat_run_id, 1).await;
    capturing.stop().await;

    let turn_one = fixture.snapshot_ref(0, 1);
    assert_eq!(fixture.snapshot_refs().await, vec![turn_one.clone()]);
    let files = fixture
        .read_captures(&["ls-tree", "-r", "--name-only", turn_one.as_str()])
        .await;
    assert_eq!(
        files.lines().collect::<Vec<_>>(),
        vec!["notes.txt", "pkg/main.rs"]
    );
    assert!(
        !session_storage_folder(&fixture.data_folder, &chat_session_id).exists(),
        "a run with no execution context leaves its session's storage alone"
    );
}

// Killed by a capture that numbers a turn by its turn number or by where the run stands when the
// end lands, rather than where the log stood just past the turn's own start, and by one that keeps
// the epoch in memory, which a capture built after the rollback does not hold: turn 2 ends after
// turn 3 started, so where the run stands at the end is epoch 1's second turn.
#[tokio::test]
async fn a_late_end_after_a_rollback_and_a_restart_lands_where_its_turn_started() {
    let fixture = Fixture::new().await;
    let capturing = fixture.capture().start(&fixture.log.followers);
    fixture.start_turn(fixture.run_id).await;
    fixture.end_turn(fixture.run_id, 1).await;
    capturing.stop().await;
    let cut = RunCut {
        run_id: fixture.run_id,
        target_position: SourcePosition(SafeInt::ZERO),
    };
    let hold = SESSION_APPEND_LOCK.acquire(fixture.session_id).await;
    fixture
        .engine
        .roll_back(cut, Vec::new(), RunWriteCompanions::default(), &hold)
        .await
        .expect("the rollback is written");
    drop(hold);
    fixture.start_turn(fixture.run_id).await;
    fixture.start_turn(fixture.run_id).await;

    let capturing = fixture.capture().start(&fixture.log.followers);
    fixture.end_turn(fixture.run_id, 2).await;
    capturing.stop().await;

    assert_eq!(
        fixture.snapshot_refs().await,
        vec![fixture.snapshot_ref(0, 1), fixture.snapshot_ref(1, 1)]
    );
}
