//! Posting a finished run's results into the session that asks for them. A post appends
//! `workflow.results.posted` to the asking session's log, naming that session, the run and the
//! run's summary line, whichever session the run lives in; a run that has not finished is refused.
//! The results post handler posts for `/workflow results` and the agent's tool, and the run's
//! ending posts for a run a chat asked for.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::run::events::WorkflowResultsPostedPayload;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use crate::not_found::WorkflowNotFound;
use crate::runs::record::{RunProgress, finished_run_condition, read_run_progress};

/// The statements the poster's reads run: the run's progress.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the results post handler and the run's ending, which post a finished run's results"
    )
)]
pub(crate) const WORKFLOW_RESULTS_POSTER_STATEMENT_CAPACITY: usize = 1;

/// The position in a post's write of the statement that refuses the write unless the run has
/// finished.
pub(crate) const RESULTS_FINISHED_CHECK_STATEMENT_INDEX: usize = 0;

// Matches the run only while it has finished, so a post's write refuses a run deleted since its
// read: a finished run never goes back to going.
static FINISHED_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run.id FROM workflow_runs AS run WHERE run.id = @workflow_run_id AND {}",
        finished_run_condition("run")
    )
});

/// Why a run's results were not posted; nothing was appended.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowResultsPostError {
    /// No run has the id (`workflow.run.notFound`).
    #[error(transparent)]
    NotFound(#[from] WorkflowNotFound),
    /// The run has not finished (`workflow.invalidTransition`).
    #[error(transparent)]
    Refused(DomainError),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// SQLite refused the run's read, or a stored value did not read as its type.
    #[error("a read of the run to post failed")]
    Read(#[from] rusqlite::Error),
    /// The results event broke one of its type's checks.
    #[error("the run's results event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep the post's write.
    #[error("the run's results were not posted")]
    Append(#[from] SessionEventAppendError),
}

impl From<WorkflowResultsPostError> for HandlerError {
    /// A run not found and a run not finished answer their refusals; any other failure is a fault
    /// in the daemon.
    fn from(error: WorkflowResultsPostError) -> Self {
        match error {
            WorkflowResultsPostError::NotFound(not_found) => Self::Refused(not_found.into()),
            WorkflowResultsPostError::Refused(refusal) => Self::Refused(refusal),
            fault @ (WorkflowResultsPostError::Pool(_)
            | WorkflowResultsPostError::Read(_)
            | WorkflowResultsPostError::Draft(_)
            | WorkflowResultsPostError::Append(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// Posts finished runs' results into the sessions that ask, reading through the daemon's read
/// pool and appending through the event log.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the results post handler and the run's ending, which post a finished run's results"
    )
)]
pub(crate) struct WorkflowResultsPoster {
    pool: Arc<DatabaseReadPool>,
    appender: SessionEventAppender,
}

impl WorkflowResultsPoster {
    /// The poster reading through `pool` and appending to `event_log`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the results post handler and the run's ending, which post a finished run's \
                      results"
        )
    )]
    pub(crate) fn new(pool: Arc<DatabaseReadPool>, event_log: Arc<EventLogService>) -> Self {
        Self {
            pool,
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
        }
    }

    /// Appends `workflow.results.posted` for run `workflow_run_id` to `session_id`'s log, the
    /// session that asked, with the run's summary line. Fails with
    /// [`WorkflowResultsPostError::NotFound`] for a run there is none of, deleted ones included,
    /// and with [`WorkflowResultsPostError::Refused`] (`workflow.invalidTransition`) for a run
    /// still going or parked on its failed step, appending nothing either way.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the results post handler and the run's ending, which post a finished run's \
                      results"
        )
    )]
    pub(crate) async fn post(
        &self,
        workflow_run_id: WorkflowRunId,
        session_id: SessionId,
    ) -> Result<(), WorkflowResultsPostError> {
        let stored = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WorkflowResultsPostError>(read_run_progress(connection, workflow_run_id)?)
            })
            .await?
            .ok_or(WorkflowNotFound::Run { workflow_run_id })?;
        match stored.progress() {
            RunProgress::Going | RunProgress::ParkedOnFailedStep => {
                Err(WorkflowResultsPostError::Refused(DomainError::new(
                    format!(
                        "Workflow run {workflow_run_id} has not finished, so its results cannot \
                         be posted yet."
                    ),
                    RefusalCode::WorkflowInvalidTransition,
                )))
            }
            RunProgress::Finished => {
                self.append_posted(workflow_run_id, session_id, stored.summary)
                    .await
            }
        }
    }

    // Appends the results event drafted for `session_id`, in a write that first checks the run has
    // finished, so a run deleted since the read is refused as not found.
    async fn append_posted(
        &self,
        workflow_run_id: WorkflowRunId,
        session_id: SessionId,
        summary: Option<NonEmptyText>,
    ) -> Result<(), WorkflowResultsPostError> {
        let draft = SessionEventDraft::of_session(
            session_id,
            &SessionEvent::WorkflowResultsPosted(WorkflowResultsPostedPayload {
                session_id,
                workflow_run_id,
                summary,
            }),
        )?;
        let finished_check = WriteStatement {
            sql: Cow::Borrowed(FINISHED_RUN_SQL.as_str()),
            bindings: StatementBindings::Named(vec![text_binding(
                "@workflow_run_id",
                workflow_run_id.text().as_str(),
            )]),
            expected_row_count: Some(1),
        };
        let linkage = SessionEventLinkage {
            transactional_prelude: vec![finished_check],
            ..SessionEventLinkage::default()
        };
        match self.appender.append(draft, linkage).await {
            Ok(_) => Ok(()),
            Err(append)
                if append.refused_statement_index()
                    == Some(RESULTS_FINISHED_CHECK_STATEMENT_INDEX) =>
            {
                Err(WorkflowNotFound::Run { workflow_run_id }.into())
            }
            Err(append) => Err(append.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use rusqlite::Connection;
    use serde_json::{Value, json};
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::workflow::run::id::WorkflowRunId;
    use sidekicks_contracts::workflow::run::status::WorkflowRunStatus;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use sidekicks_store::events::log_service::{
        EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
    };
    use sidekicks_store::events::session::followers::SessionEventFollowers;

    use super::{
        WORKFLOW_RESULTS_POSTER_STATEMENT_CAPACITY, WorkflowResultsPostError, WorkflowResultsPoster,
    };
    use crate::not_found::WorkflowNotFound;
    use crate::test_rows::{insert_run, insert_workflow_version};

    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e50";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e51";
    const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d0001";
    const ASKING_SESSION_ID: &str = "00000000-0000-7000-8000-000000000002";
    const STARTED: &str = "2026-10-01T00:00:00.000Z";
    const ENDED: &str = "2026-10-02T00:00:00.000Z";

    /// The poster over a test database holding the event and workflow tables and one workflow
    /// version, with a connection the test writes and reads rows through.
    async fn open_poster(database: &TestDatabase) -> (WorkflowResultsPoster, Connection) {
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens the test database"),
        );
        let pool = Arc::new(DatabaseReadPool::new(
            database.path(),
            EVENT_LOG_STATEMENT_CAPACITY + WORKFLOW_RESULTS_POSTER_STATEMENT_CAPACITY,
        ));
        let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
            writer,
            pool: Arc::clone(&pool),
            followers: Arc::new(SessionEventFollowers::default()),
            projection_statements: None,
            refuse_session_write: None,
            read_damaged_from_sequence: None,
        }));
        let rows = database.reader();
        insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Nightly");
        (WorkflowResultsPoster::new(pool, event_log), rows)
    }

    fn run_id() -> WorkflowRunId {
        WorkflowRunId::new(RUN_ID).expect("the test's run id")
    }

    fn asking_session_id() -> SessionId {
        SessionId::new(ASKING_SESSION_ID).expect("the test's session id")
    }

    // Every results event in the log, with the session whose log holds it, in sequence order.
    fn posted_events(rows: &Connection) -> Vec<(String, Value)> {
        let mut statement = rows
            .prepare(
                "SELECT session_id, payload FROM session_events
                 WHERE type = 'workflow.results.posted' ORDER BY session_id, sequence",
            )
            .expect("the test reads the log");
        statement
            .query_map([], |row| {
                let payload: String = row.get(1)?;
                Ok((
                    row.get(0)?,
                    serde_json::from_str(&payload).expect("a payload is JSON"),
                ))
            })
            .expect("the test reads the log")
            .collect::<rusqlite::Result<_>>()
            .expect("the log reads")
    }

    /// A finished run, a failed one that ended among them, posts one results event into the
    /// asking session's log, naming that session and the run, with the summary line exactly where
    /// the run's row holds one; the run's own session's log gets none. Mutations: draft the event
    /// for the run's own session; name the run's session in the payload; refuse every failed run;
    /// drop or invent the summary.
    #[rstest]
    #[case::succeeded_with_a_summary(WorkflowRunStatus::Succeeded, Some("Shipped three fixes."))]
    #[case::canceled(WorkflowRunStatus::Canceled, None)]
    #[case::crashed(WorkflowRunStatus::Crashed, None)]
    #[case::failed_and_ended(WorkflowRunStatus::Failed, None)]
    #[tokio::test]
    async fn a_finished_run_posts_once_into_the_asking_sessions_log(
        #[case] status: WorkflowRunStatus,
        #[case] summary: Option<&str>,
    ) {
        let database = TestDatabase::new(crate::schema::schema_parts());
        let (poster, rows) = open_poster(&database).await;
        insert_run(&rows, RUN_ID, VERSION_ID, status, STARTED, Some(ENDED));
        rows.execute(
            "UPDATE workflow_runs SET summary = ?1 WHERE id = ?2",
            rusqlite::params![summary, RUN_ID],
        )
        .expect("the test writes the run's summary");

        poster
            .post(run_id(), asking_session_id())
            .await
            .expect("a finished run's results post");

        let mut payload = json!({ "sessionId": ASKING_SESSION_ID, "workflowRunId": RUN_ID });
        if let Some(summary) = summary {
            payload["summary"] = json!(summary);
        }
        assert_eq!(
            posted_events(&rows),
            vec![(ASKING_SESSION_ID.to_owned(), payload)]
        );
    }

    /// A run still going or parked on its failed step is refused `workflow.invalidTransition`, and
    /// a run no row answers to `workflow.run.notFound`; none appends anything. Mutations: drop the
    /// parked condition; drop the going statuses; answer a missing run `invalidTransition`.
    #[rstest]
    #[case::new(Some(WorkflowRunStatus::New), RefusalCode::WorkflowInvalidTransition)]
    #[case::running(
        Some(WorkflowRunStatus::Running),
        RefusalCode::WorkflowInvalidTransition
    )]
    #[case::waiting(
        Some(WorkflowRunStatus::Waiting),
        RefusalCode::WorkflowInvalidTransition
    )]
    #[case::parked(
        Some(WorkflowRunStatus::Failed),
        RefusalCode::WorkflowInvalidTransition
    )]
    #[case::missing(None, RefusalCode::WorkflowRunNotFound)]
    #[tokio::test]
    async fn an_unfinished_or_missing_run_posts_nothing(
        #[case] status: Option<WorkflowRunStatus>,
        #[case] code: RefusalCode,
    ) {
        let database = TestDatabase::new(crate::schema::schema_parts());
        let (poster, rows) = open_poster(&database).await;
        if let Some(status) = status {
            insert_run(&rows, RUN_ID, VERSION_ID, status, STARTED, None);
        }

        let error = poster
            .post(run_id(), asking_session_id())
            .await
            .expect_err("the post is refused");

        match HandlerError::from(error) {
            HandlerError::Refused(refusal) => assert_eq!(refusal.code, code),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert_eq!(posted_events(&rows), Vec::new());
    }

    /// The post's own write refuses a run that has not finished, so a run deleted between the read
    /// and the write appends nothing. Mutations: drop the finished check from the write; leave its
    /// expected row count unset.
    #[tokio::test]
    async fn the_append_refuses_a_run_that_is_not_finished() {
        let database = TestDatabase::new(crate::schema::schema_parts());
        let (poster, rows) = open_poster(&database).await;
        insert_run(
            &rows,
            RUN_ID,
            VERSION_ID,
            WorkflowRunStatus::Running,
            STARTED,
            None,
        );

        let error = poster
            .append_posted(run_id(), asking_session_id(), None)
            .await
            .expect_err("the write is refused at its finished check");

        assert!(
            matches!(
                error,
                WorkflowResultsPostError::NotFound(WorkflowNotFound::Run { workflow_run_id })
                    if workflow_run_id == run_id()
            ),
            "{error:?}"
        );
        assert_eq!(posted_events(&rows), Vec::new());
    }
}
