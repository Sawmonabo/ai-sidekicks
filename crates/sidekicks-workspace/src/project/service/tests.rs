//! The project writer's tests: attach makes the project and its mount in one write and finds the
//! project holding a repository with nothing written, a chat's own workspace is no project, and an
//! edit refused or aimed at no project writes nothing.

use std::error::Error;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::Connection;
use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::machine::settings::{EnvironmentRow, MachineSettings};
use sidekicks_contracts::project::{ProjectId, ProjectName, ProjectState};
use sidekicks_contracts::repo::folders::RepoMountAttachRequest;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::real_path;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::EVENT_LOG_STATEMENT_CAPACITY;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use tempfile::TempDir;

use super::{ForgottenProjectSessions, ProjectService, ProjectServiceDeps, ProjectServiceError};
use crate::event_emitter::WorkspaceEventEmitter;
use crate::git::process::{GitCall, test_git_runner};
use crate::git::worktree::schema::schema_parts;
use crate::machine_settings::MachineSettingsReader;
use crate::project::list_feed::ProjectListFeed;
use crate::project::records::{
    PROJECT_RECORDS_STATEMENT_CAPACITY, ProjectRecords, ProjectSessionActivity, ProjectSessionFacts,
};
use crate::repo::errors::RepoRefusal;
use crate::repo::mount::service::{
    REPO_MOUNT_SERVICE_STATEMENT_CAPACITY, RepoMountService, RepoMountServiceError,
};
use crate::repo::root_resolver::RepoRootResolver;
use crate::test_rows::PARENT_ROWS_AT;

// No session counts in any project: these tests read only the project rows.
struct NoSessions;

impl ProjectSessionActivity for NoSessions {
    fn read_session_facts(
        &self,
        _reader: &Connection,
        _project_ids: Option<&[ProjectId]>,
    ) -> rusqlite::Result<Vec<ProjectSessionFacts>> {
        Ok(Vec::new())
    }
}

// A port no test here reaches: no test detaches or clears a pattern.
struct Unreached;

impl ForgottenProjectSessions for Unreached {
    fn archive_of_forgotten_project(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err("no test archives a session".into()) }.boxed()
    }
}

impl MachineSettingsReader for Unreached {
    fn read_machine_settings(
        &self,
    ) -> BoxFuture<'_, Result<MachineSettings, Box<dyn Error + Send + Sync>>> {
        async { Err("no test reads the machine's settings".into()) }.boxed()
    }
}

struct Writer {
    service: ProjectService,
    mounts: Arc<RepoMountService>,
    log: TestLog,
    _worktrees: TempDir,
}

impl Writer {
    async fn open(database: &TestDatabase) -> Self {
        let log = open_log(database, None).await;
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            EVENT_LOG_STATEMENT_CAPACITY
                + REPO_MOUNT_SERVICE_STATEMENT_CAPACITY
                + PROJECT_RECORDS_STATEMENT_CAPACITY,
        ));
        let git = test_git_runner();
        let mounts = Arc::new(RepoMountService::new(
            Arc::clone(&log.writer),
            Arc::clone(&reads),
            Arc::new(WorkspaceEventEmitter::new(Arc::clone(&log.service))),
            RepoRootResolver::new(git.clone()),
            MachineId::new("machine".to_owned()).expect("the id is short"),
        ));
        let records = Arc::new(ProjectRecords::new(reads, Arc::new(NoSessions)));
        let worktrees = tempfile::tempdir().expect("the worktrees folder is made");
        let service = ProjectService::new(ProjectServiceDeps {
            writer: Arc::clone(&log.writer),
            records: Arc::clone(&records),
            mounts: Arc::clone(&mounts),
            sessions: Arc::new(Unreached),
            git,
            settings: Arc::new(Unreached),
            driver_set_names: Vec::new(),
            worktrees_folder: worktrees.path().to_path_buf(),
            list_feed: Arc::new(ProjectListFeed::new(records, &log.followers)),
        });
        Self {
            service,
            mounts,
            log,
            _worktrees: worktrees,
        }
    }

    // The writes committed so far.
    fn commits(&self) -> u64 {
        *self.log.writer.follow_commits().borrow()
    }
}

// A fresh repository at `folder`, resolved as attach resolves it.
async fn init_repository(folder: &Path) -> PathBuf {
    test_git_runner()
        .run(
            None,
            GitCall::read([OsStr::new("init"), folder.as_os_str()]),
        )
        .await
        .expect("the repository is made");
    real_path(folder).expect("the repository resolves")
}

fn attach_request(folder: &Path) -> RepoMountAttachRequest {
    RepoMountAttachRequest {
        local_path: FilesystemPath::new(folder.to_string_lossy().into_owned())
            .expect("the folder is a wire path"),
        place: None,
    }
}

fn count_rows(database: &TestDatabase, table: &str) -> i64 {
    database
        .reader()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("the rows count")
}

// Kills the project row written apart from its mount (two writes), a found project written again,
// and a chat's managed mount answered as a project.
#[tokio::test]
async fn attach_makes_one_project_in_one_write_finds_it_again_and_rethrows_a_chat_workspace() {
    let database = TestDatabase::new(schema_parts());
    let writer = Writer::open(&database).await;
    let folders = tempfile::tempdir().expect("the folders are made");
    let app = init_repository(&folders.path().join("app")).await;

    let before = writer.commits();
    let attached = writer
        .service
        .attach_or_find(&attach_request(&app))
        .await
        .expect("the folder attaches");
    assert_eq!(
        writer.commits(),
        before + 1,
        "the project and its mount are one write"
    );
    assert_eq!(count_rows(&database, "projects"), 1);
    assert_eq!(count_rows(&database, "repo_mounts"), 1);

    let found = writer
        .service
        .attach_or_find(&attach_request(&app))
        .await
        .expect("the attached folder is found");
    assert_eq!(found, attached, "the same project and mount are answered");
    assert_eq!(
        writer.commits(),
        before + 1,
        "finding the project writes nothing"
    );

    let chat = init_repository(&folders.path().join("chat")).await;
    let chat_mount = writer
        .mounts
        .attach_managed(test_session_id(), &chat, None)
        .await
        .expect("the chat's workspace is registered");
    let refused = writer
        .service
        .attach_or_find(&attach_request(&chat))
        .await
        .expect_err("a chat's workspace is no project");
    assert!(
        matches!(
            refused,
            ProjectServiceError::Mount(RepoMountServiceError::Refused(
                RepoRefusal::AlreadyAttached {
                    conflicting_repo_mount_id,
                    conflicting_project_id: None,
                }
            )) if conflicting_repo_mount_id == chat_mount
        ),
        "the chat's mount is named: {refused:?}"
    );
    assert_eq!(count_rows(&database, "projects"), 1);
}

#[derive(Clone, Copy, Debug)]
enum Edit {
    ArchiveCloning,
    RenameUnknown,
    RefusedEnvironmentRow,
}

// Kills the archive's state guard dropped (a cloning project archived), the existence guard's
// expected count dropped (an unknown id's write commits), and the row check moved after the write.
#[rstest]
#[case::a_no_op_archive_answers_the_entry(Edit::ArchiveCloning)]
#[case::an_unknown_id_is_not_found(Edit::RenameUnknown)]
#[case::a_refused_row_writes_nothing(Edit::RefusedEnvironmentRow)]
#[tokio::test]
async fn an_edit_answers_or_refuses_as_its_project_stands(#[case] edit: Edit) {
    let database = TestDatabase::new(schema_parts());
    let writer = Writer::open(&database).await;
    let cloning = ProjectId::try_from(mint_uuid_v7()).expect("a minted UUID is a project id");
    database
        .reader()
        .execute(
            "INSERT INTO projects (id, name, slug, folder_path, state, clone_url, clone_outcome, \
             setup, created_at, updated_at) VALUES (?1, 'app', 'app', '/repos/app', 'cloning', \
             'https://example.invalid/app.git', 'running', \
             '{\"filesToCopy\":[],\"commands\":[]}', ?2, ?2)",
            rusqlite::params![cloning.text().as_str(), PARENT_ROWS_AT],
        )
        .expect("the cloning project is stored");
    let before = writer.commits();

    match edit {
        Edit::ArchiveCloning => {
            let answered = writer
                .service
                .archive(cloning)
                .await
                .expect("a no-op archive answers");
            assert_eq!(answered.project.state, ProjectState::Cloning);
        }
        Edit::RenameUnknown => {
            let unknown =
                ProjectId::try_from(mint_uuid_v7()).expect("a minted UUID is a project id");
            let refused = writer
                .service
                .rename(
                    unknown,
                    &ProjectName::new("renamed".to_owned()).expect("the name is text"),
                )
                .await
                .expect_err("an unknown project is refused");
            assert!(
                matches!(
                    refused,
                    ProjectServiceError::Refused(RepoRefusal::ProjectNotFound { project_id })
                        if project_id == unknown
                ),
                "{refused:?}"
            );
            assert_eq!(writer.commits(), before, "nothing is written");
        }
        Edit::RefusedEnvironmentRow => {
            let row: EnvironmentRow =
                serde_json::from_value(json!({ "name": "1BAD", "value": "x" }))
                    .expect("the row reads");
            let refused = writer
                .service
                .update_environment(cloning, &[row])
                .await
                .expect_err("a refused row is refused");
            assert!(
                matches!(refused, ProjectServiceError::InputRefused(_)),
                "{refused:?}"
            );
            assert_eq!(writer.commits(), before, "nothing is written");
        }
    }
}
