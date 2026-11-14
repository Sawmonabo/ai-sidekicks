//! A session with a checkpoint whose run works in a repository, and the command windows, the
//! captures and the packing over it, for the tests of the windows and of the checkpoint sweep.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::SnapshotId;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::real_path;
use sidekicks_provider::port::command_capture::{
    CommandCapture as _, CommandWindowEnd, CommandWindowId as PortWindowId, CommandWindowStart,
};
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::data_folder::session_storage_folder;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_workspace::git::process::test_repository::{git_in, make_test_repository};
use sidekicks_workspace::git::process::{GitRunner, test_git_runner};
use sidekicks_workspace::git::turn_snapshot::capture::GitFloorReports;
use sidekicks_workspace::git::turn_snapshot::command_capture::CommandCaptureService;
use sidekicks_workspace::git::turn_snapshot::repack::CapturePacking;
use sidekicks_workspace::git::worktree::test_rows::{RunContextRow, insert_worktree_rows};
use tempfile::TempDir;

use super::{COMMAND_WINDOWS_STATEMENT_CAPACITY, CommandWindows, CommandWindowsDeps};
use crate::checkpoints::copies::CopyStore;
use crate::checkpoints::schema::{CheckpointVersionContent, schema_parts};
use crate::checkpoints::store::kept::read_kept_checkpoint;
use crate::checkpoints::store::{
    Checkpoint, CheckpointVersion, UncoveredCommand, insert_checkpoint_statement,
    uncovered_commands, versions_after,
};
use crate::run::engine::test_fixture;

/// A session with a checkpoint, its run's checkout a repository, and the windows over them.
pub(crate) struct Fixture {
    /// The database, with the checkpoints' tables and the workflow tables.
    pub(crate) database: TestDatabase,
    /// The log, whose writer every write goes through.
    pub(crate) log: TestLog,
    /// The command windows.
    pub(crate) windows: Arc<CommandWindows>,
    /// The captures the windows take.
    pub(crate) captures: Arc<CommandCaptureService>,
    /// The packing the windows' captures go through.
    pub(crate) packing: Arc<CapturePacking>,
    /// The session.
    pub(crate) session_id: SessionId,
    /// The session's checkpoint.
    pub(crate) checkpoint_id: SnapshotId,
    /// The checkout, as the test made it.
    pub(crate) checkout: PathBuf,
    /// The data folder, which holds the session's storage folder.
    pub(crate) data_folder: PathBuf,
    _root: TempDir,
}

impl Fixture {
    /// A run bound to a repository whose files `files` names are committed; with none, the
    /// repository keeps only its empty commit, since git refuses a commit with nothing to commit.
    /// The run's context is the session's.
    pub(crate) async fn with_repository(files: &[(&str, &str)]) -> Self {
        let root = tempfile::tempdir().expect("the test makes its folder");
        let git = test_git_runner();
        let repository = make_test_repository(&git, root.path(), "repository").await;
        if !files.is_empty() {
            for (name, text) in files {
                std::fs::write(repository.join(name), text).expect("the test writes a file");
            }
            git_in(&git, &repository, &["add", "--all"]).await;
            git_in(
                &git,
                &repository,
                &[
                    "-c",
                    "commit.gpgSign=false",
                    "commit",
                    "--quiet",
                    "-m",
                    "files",
                ],
            )
            .await;
        }
        let fixture = Self::open(root, git, repository.clone()).await;
        let run_id = fixture.insert_run();
        let rows = fixture.database.reader();
        insert_worktree_rows(&rows);
        let run_key = run_id.to_string();
        let session_key = fixture.session_id.to_string();
        let git_common_dir = repository.join(".git");
        RunContextRow {
            run_id: &run_key,
            session_id: &session_key,
            execution_root: utf8(&repository),
            checkout_root: Some(utf8(&repository)),
            git_common_dir: Some(utf8(&git_common_dir)),
            ..RunContextRow::BOUND_ROOT
        }
        .insert(&rows)
        .expect("the test stores the run's context");
        fixture.insert_checkpoint(run_id).await;
        fixture
    }

    /// The database, the log and the windows over `checkout`, with no row yet.
    pub(crate) async fn open(root: TempDir, git: GitRunner, checkout: PathBuf) -> Self {
        let database = TestDatabase::new(
            schema_parts().with_parts(sidekicks_workflow::schema::schema_parts()),
        );
        let log = open_log(&database, None).await;
        let floor_reports = Arc::new(GitFloorReports::default());
        let data_folder = root.path().join("data");
        let packing = Arc::new(CapturePacking::new(git.clone(), Arc::clone(&floor_reports)));
        let captures = Arc::new(CommandCaptureService::new(
            git.clone(),
            Arc::new(KeyedLock::new()),
            Arc::clone(&packing),
            floor_reports,
        ));
        let windows = Arc::new(CommandWindows::new(CommandWindowsDeps {
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                COMMAND_WINDOWS_STATEMENT_CAPACITY,
            )),
            writer: Arc::clone(&log.writer),
            captures: Arc::clone(&captures),
            packing: Arc::clone(&packing),
            data_folder: data_folder.clone(),
        }));
        Self {
            database,
            log,
            windows,
            captures,
            packing,
            session_id: SessionId::try_from(mint_uuid_v7()).expect("a session id"),
            checkpoint_id: SnapshotId::new(mint_uuid_v7().to_string()).expect("a snapshot id"),
            checkout,
            data_folder,
            _root: root,
        }
    }

    /// A running run of the session, stored.
    pub(crate) fn insert_run(&self) -> RunId {
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a run id");
        test_fixture::insert_run(&self.database, self.session_id, run_id, "running");
        run_id
    }

    /// The session's checkpoint, under `run_id`, written.
    pub(crate) async fn insert_checkpoint(&self, run_id: RunId) {
        let checkpoint = Checkpoint {
            checkpoint_id: self.checkpoint_id.clone(),
            session_id: self.session_id,
            message_sequence: SafeInt::ZERO,
            run_id,
            turn_number: SafeInt::new(1).expect("a turn number"),
            turn: EpochPosition {
                epoch: SourceEpoch(SafeInt::ZERO),
                position: SourcePosition(SafeInt::ZERO),
            },
        };
        self.log
            .writer
            .write(vec![insert_checkpoint_statement(&checkpoint)])
            .await
            .expect("the checkpoint is written");
    }

    /// Opens a window for the session's command.
    pub(crate) async fn open_window(&self) -> PortWindowId {
        self.windows
            .open_window(self.start())
            .await
            .expect("the window opens")
    }

    /// The start of the session's command.
    pub(crate) fn start(&self) -> CommandWindowStart {
        CommandWindowStart {
            session_id: self.session_id,
            apart_run: None,
            command: "npm test".to_owned(),
            tool_call_id: None,
        }
    }

    /// Closes `window` as `end` says and waits for every close under way to be written.
    pub(crate) async fn close(&self, window: PortWindowId, end: CommandWindowEnd) {
        self.windows.close_window(window, end).await;
        self.windows.stop().await;
    }

    /// `relative` under the checkout's real path, as the rows record it.
    pub(crate) fn recorded(&self, relative: &str) -> FilesystemPath {
        let real = real_path(&self.checkout).expect("the checkout's real path reads");
        FilesystemPath::new(utf8(&real.join(relative)).to_owned()).expect("a recorded path")
    }

    /// The session's checkpoint as its row holds it, the point every read of what came after it
    /// starts at; `None` before it is written.
    fn point(&self) -> Option<Checkpoint> {
        read_kept_checkpoint(
            &self.database.reader(),
            self.session_id,
            &self.checkpoint_id,
        )
        .expect("the checkpoint reads")
    }

    /// Every path's earliest version in the session.
    pub(crate) fn versions(&self) -> Vec<CheckpointVersion> {
        let Some(point) = self.point() else {
            return Vec::new();
        };
        versions_after(&self.database.reader(), self.session_id, &point)
            .expect("the versions read")
            .into_iter()
            .map(|stored| stored.version)
            .collect()
    }

    /// The earliest version of `relative` in the session, if any.
    pub(crate) fn version_of(&self, relative: &str) -> Option<CheckpointVersion> {
        let path = self.recorded(relative);
        self.versions()
            .into_iter()
            .find(|version| version.path == path)
    }

    /// The window's `covered` column, `None` while it is open.
    pub(crate) fn covered(&self, window: &PortWindowId) -> Option<i64> {
        self.database
            .reader()
            .query_row(
                "SELECT covered FROM checkpoint_commands WHERE window_id = ?1",
                [window.as_str()],
                |row| row.get(0),
            )
            .expect("the window's row reads")
    }

    /// The session's commands recorded uncovered, in the order they ran.
    pub(crate) fn uncovered(&self) -> Vec<UncoveredCommand> {
        let Some(point) = self.point() else {
            return Vec::new();
        };
        uncovered_commands(&self.database.reader(), self.session_id, &point)
            .expect("the uncovered commands read")
    }

    /// How many of the session's commands are recorded uncovered.
    pub(crate) fn uncovered_count(&self) -> usize {
        self.uncovered().len()
    }

    /// The bytes the copy named `hash` keeps.
    pub(crate) fn copy_bytes(&self, content: &CheckpointVersionContent) -> Vec<u8> {
        let CheckpointVersionContent::Copy { hash, .. } = content else {
            panic!("a copy, not {content:?}");
        };
        let store = CopyStore::open(&session_storage_folder(&self.data_folder, &self.session_id))
            .expect("the copies folder opens");
        std::fs::read(store.copy_path(hash)).expect("the copy reads")
    }

    /// Every shadow row of `relative`: its id, its clone, and whether it is current.
    pub(crate) fn shadows_of(&self, relative: &str) -> Vec<(String, Option<String>, bool)> {
        let reader = self.database.reader();
        let mut statement = reader
            .prepare(
                "SELECT shadow_id, clone_path, is_current FROM checkpoint_shadows
                  WHERE path = ?1 ORDER BY rowid",
            )
            .expect("the shadows' read prepares");
        statement
            .query_map([self.recorded(relative).as_str()], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .expect("the shadows read")
            .collect::<rusqlite::Result<_>>()
            .expect("each shadow reads")
    }
}

/// `path` as text, which every temporary folder's path is.
pub(crate) fn utf8(path: &Path) -> &str {
    path.to_str().expect("the temporary folder's path is UTF-8")
}
