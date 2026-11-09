//! A project session's start bound through the setup gate: the binder the starter holds, and the
//! root a `preparing` workspace's binding makes.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::trigger::WorkflowRunChainPlace;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_workspace::project::records::AttachedProjectRoot;
use sidekicks_workspace::run_setup_gates::RunSetupGateError;
use sidekicks_workspace::run_setup_gates::execution_root::context::{
    RunContextBinding, SessionRunBinder,
};

use super::{
    Fixture, REPOSITORY_MOUNT_ID, TestSession, body, git_node, runs_folders, session_id, start,
    started,
};
use crate::engine::ports::noticed_sessions::NoticedSessions;
use crate::engine::start::WorkflowStartArrival;

// Archives every workspace of the session, as a detach that commits after a binding would.
const ARCHIVE_SESSION_WORKSPACES_SQL: &str =
    "UPDATE workspaces SET state = @archived WHERE session_id = @session_id";

/// The setup gate a start binds through, keeping each session its notices name; told to, it
/// archives the session's workspaces right after a binding, so the start's context write is
/// refused.
pub(super) struct TestBinder {
    gate: Box<dyn SessionRunBinder>,
    writer: Arc<DatabaseWriter>,
    /// The sessions the start's notices named.
    pub(super) notices: NoticedSessions,
    /// Whether a binding is followed by the archive.
    pub(super) archives_after_binding: AtomicBool,
}

impl TestBinder {
    /// The binder over `gate`, archiving through `writer` once told to.
    pub(super) fn new(gate: impl SessionRunBinder + 'static, writer: Arc<DatabaseWriter>) -> Self {
        Self {
            gate: Box::new(gate),
            writer,
            notices: NoticedSessions::default(),
            archives_after_binding: AtomicBool::new(false),
        }
    }
}

impl SessionRunBinder for TestBinder {
    fn bind_session_run<'a>(
        &'a self,
        session_id: SessionId,
        run_id: &'a str,
        opening_words: &'a str,
    ) -> BoxFuture<'a, Result<RunContextBinding, RunSetupGateError>> {
        Box::pin(async move {
            let binding = self
                .gate
                .bind_session_run(session_id, run_id, opening_words)
                .await?;
            if self.archives_after_binding.load(Ordering::SeqCst) {
                self.writer
                    .write(vec![WriteStatement {
                        sql: Cow::Borrowed(ARCHIVE_SESSION_WORKSPACES_SQL),
                        bindings: StatementBindings::Named(vec![
                            text_binding(
                                "@archived",
                                <&'static str>::from(WorkspaceState::Archived),
                            ),
                            text_binding("@session_id", session_id.text().as_str()),
                        ]),
                        expected_row_count: None,
                    }])
                    .await
                    .expect("the session's workspaces are archived");
            }
            Ok(binding)
        })
    }

    fn bind_project_run<'a>(
        &'a self,
        session_id: SessionId,
        workflow_run_id: WorkflowRunId,
        root: &'a AttachedProjectRoot,
    ) -> BoxFuture<'a, Result<RunContextBinding, RunSetupGateError>> {
        self.gate
            .bind_project_run(session_id, workflow_run_id, root)
    }

    fn discard_project_run(
        &self,
        workflow_run_id: WorkflowRunId,
    ) -> BoxFuture<'_, Result<(), RunSetupGateError>> {
        self.gate.discard_project_run(workflow_run_id)
    }

    fn hold_checkout<'a>(
        &'a self,
        binding: &'a RunContextBinding,
    ) -> BoxFuture<'a, KeyHold<'a, PathBuf>> {
        self.gate.hold_checkout(binding)
    }

    fn note_context_changed(&self, session_id: SessionId) {
        self.notices.note_context_changed(session_id);
    }
}

/// A project session whose workspace is still `preparing` reads no working folder, so the start's
/// binding makes its root, the run works there and records it, its steps take the project's own
/// environment rows, and the session's binder is told once the write commits; a worktree's first
/// root is made for no agent run and, the session having no title yet, named from the workflow's
/// name. Mutations: the folder read from the session before the binding (the run works in its own
/// folder); the rows read from the session's folder, which names no repository yet (none are
/// taken); the context left out of the creation write; the notice dropped; the tree recorded as an
/// agent run's; the workflow's name left out of the binding (the tree is named `run-<id>`).
#[rstest]
#[case::a_bound_folder(ExecutionMode::BoundRoot)]
#[case::a_worktree(ExecutionMode::ProvisionedWorktree)]
#[tokio::test]
async fn a_project_sessions_start_binds_its_preparing_workspace(#[case] mode: ExecutionMode) {
    let fixture = Fixture::new(
        &body(None, &json!([git_node()])),
        TestSession::PreparingProject(mode),
        None,
    )
    .await;
    fixture
        .rows
        .execute(
            "UPDATE projects SET environment_rows = '[{\"name\":\"REGION\",\"value\":\"eu\"}]' \
             WHERE id = ?1",
            [REPOSITORY_MOUNT_ID],
        )
        .expect("the test sets the project's environment rows");

    let run = started(
        fixture
            .starter
            .start(start(
                WorkflowStartArrival::Person,
                WorkflowRunChainPlace::Starts {},
                Vec::new(),
            ))
            .await,
    );

    let (_, root, _, released_at) = fixture
        .execution_context(run.scope.run_id)
        .expect("the run records its execution context");
    assert_eq!(released_at, None);
    assert_eq!(run.scope.working_folder, Path::new(&root));
    match mode {
        ExecutionMode::BoundRoot => assert_eq!(run.scope.working_folder, fixture.roots.repository),
        ExecutionMode::ProvisionedWorktree => {
            let tree: (String, Option<String>) = fixture
                .rows
                .query_row(
                    "SELECT branch_name, created_by_run_id FROM worktrees WHERE fs_root = ?1",
                    [&root],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("the run's tree is recorded");
            assert_eq!(tree, ("nightly".to_owned(), None));
        }
    }
    assert_eq!(
        serde_json::to_value(&*run.scope.environment_rows).expect("rows write as JSON"),
        json!([{ "name": "REGION", "value": "eu" }])
    );
    assert_eq!(fixture.binder.notices.sessions(), vec![session_id()]);
    assert_eq!(runs_folders(&fixture.data_folder()), Vec::<PathBuf>::new());
}
