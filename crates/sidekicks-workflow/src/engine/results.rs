//! A run's results posted into the session that asks for them: `workflow.results.posted`,
//! naming that session, the run and the run's summary line, whichever session the run lives in.
//! The ending of a run a chat or an agent asked for posts it in the ending's own write; the results
//! post handler posts it for `/workflow results` and the agent's tool, refused for a run there is
//! none of and for one that has not finished.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::run::events::WorkflowResultsPostedPayload;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use crate::not_found::WorkflowNotFound;
use crate::runs::record::finished_run_condition;

// The position in a post's write of the statement that refuses the write when no row has the run.
const RESULTS_RUN_CHECK_STATEMENT_INDEX: usize = 0;

// The position in a post's write of the statement that refuses the write unless the run has
// finished.
const RESULTS_FINISHED_CHECK_STATEMENT_INDEX: usize = 1;

// Matches the run while a row has it, so a post's write refuses a run there is none of, deleted
// ones included.
const RUN_ROW_SQL: &str = "SELECT id FROM workflow_runs WHERE id = @workflow_run_id";

// Matches the run only while it has finished, so a post's write refuses a run still going or
// parked on its failed step: a finished run never goes back to going.
static FINISHED_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run.id FROM workflow_runs AS run WHERE run.id = @workflow_run_id AND {}",
        finished_run_condition("run")
    )
});

/// Whether the ending of a run started in `mode` posts its results into the session that asked:
/// a chat's and an agent's runs do, a retry does as the run it retries would by `retried_mode`,
/// and every other run does not.
pub(crate) fn run_posts_results(
    mode: WorkflowRunMode,
    retried_mode: Option<WorkflowRunMode>,
) -> bool {
    match mode {
        WorkflowRunMode::Chat | WorkflowRunMode::Agent => true,
        WorkflowRunMode::Retry => {
            retried_mode.is_some_and(|retried| run_posts_results(retried, None))
        }
        WorkflowRunMode::Manual
        | WorkflowRunMode::Trigger
        | WorkflowRunMode::Webhook
        | WorkflowRunMode::SubWorkflow => false,
    }
}

/// The results event of run `workflow_run_id` posted into `session_id`, with its summary line.
pub(crate) fn results_posted_event(
    session_id: SessionId,
    workflow_run_id: WorkflowRunId,
    summary: Option<NonEmptyText>,
) -> SessionEvent {
    SessionEvent::WorkflowResultsPosted(WorkflowResultsPostedPayload {
        session_id,
        workflow_run_id,
        summary,
    })
}

/// Why a run's results were not posted; nothing was appended.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowResultsPostError {
    /// No run has the id (`workflow.run.notFound`).
    #[error(transparent)]
    NotFound(#[from] WorkflowNotFound),
    /// The run is still going or parked on its failed step (`workflow.invalidTransition`).
    #[error("Workflow run {workflow_run_id} has not finished, so it has no results to post.")]
    Unfinished {
        /// The run asked for.
        workflow_run_id: WorkflowRunId,
    },
    /// The results event broke one of its type's checks.
    #[error("the run's results event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep the post's write.
    #[error("the run's results were not posted")]
    Append(#[from] SessionEventAppendError),
}

impl From<WorkflowResultsPostError> for HandlerError {
    /// A run not found or unfinished answers its refusal; any other failure is a fault in the
    /// daemon.
    fn from(error: WorkflowResultsPostError) -> Self {
        match error {
            WorkflowResultsPostError::NotFound(not_found) => Self::Refused(not_found.into()),
            unfinished @ WorkflowResultsPostError::Unfinished { .. } => {
                Self::Refused(DomainError::new(
                    unfinished.to_string(),
                    RefusalCode::WorkflowInvalidTransition,
                ))
            }
            fault @ (WorkflowResultsPostError::Draft(_) | WorkflowResultsPostError::Append(_)) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

/// Posts finished runs' results into the sessions that ask, appending through the event log.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the results post handler, which posts a finished run's results"
    )
)]
pub(crate) struct WorkflowResultsPoster {
    appender: SessionEventAppender,
}

impl WorkflowResultsPoster {
    /// The poster appending to `event_log`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the results post handler, which posts a finished run's results"
        )
    )]
    pub(crate) fn new(event_log: Arc<EventLogService>) -> Self {
        Self {
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
        }
    }

    /// Appends `workflow.results.posted` for run `workflow_run_id` with `summary` to
    /// `session_id`'s log, the session that asked, in a write that first checks a row has the run
    /// and the run has finished. Fails with [`WorkflowResultsPostError::NotFound`] for a run there
    /// is none of, deleted ones included, and [`WorkflowResultsPostError::Unfinished`] for one
    /// still going or parked on its failed step, appending nothing.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the results post handler, which posts a finished run's results"
        )
    )]
    pub(crate) async fn post(
        &self,
        workflow_run_id: WorkflowRunId,
        session_id: SessionId,
        summary: Option<NonEmptyText>,
    ) -> Result<(), WorkflowResultsPostError> {
        let draft = SessionEventDraft::of_session(
            session_id,
            &results_posted_event(session_id, workflow_run_id, summary),
        )?;
        let run_check = |sql: &'static str| WriteStatement {
            sql: Cow::Borrowed(sql),
            bindings: StatementBindings::Named(vec![text_binding(
                "@workflow_run_id",
                workflow_run_id.text().as_str(),
            )]),
            expected_row_count: Some(1),
        };
        let linkage = SessionEventLinkage {
            transactional_prelude: vec![
                run_check(RUN_ROW_SQL),
                run_check(FINISHED_RUN_SQL.as_str()),
            ],
            ..SessionEventLinkage::default()
        };
        match self.appender.append(draft, linkage).await {
            Ok(_) => Ok(()),
            Err(append) => match append.refused_statement_index() {
                Some(RESULTS_RUN_CHECK_STATEMENT_INDEX) => {
                    Err(WorkflowNotFound::Run { workflow_run_id }.into())
                }
                Some(RESULTS_FINISHED_CHECK_STATEMENT_INDEX) => {
                    Err(WorkflowResultsPostError::Unfinished { workflow_run_id })
                }
                _ => Err(append.into()),
            },
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
    use sidekicks_contracts::wire::text::NonEmptyText;
    use sidekicks_contracts::workflow::run::id::WorkflowRunId;
    use sidekicks_contracts::workflow::run::status::WorkflowRunStatus;
    use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use sidekicks_store::events::log_service::{
        EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
    };
    use sidekicks_store::events::session::followers::SessionEventFollowers;

    use super::{WorkflowResultsPoster, run_posts_results};
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
            EVENT_LOG_STATEMENT_CAPACITY,
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
        (WorkflowResultsPoster::new(event_log), rows)
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
    /// asking session's log, naming that session, the run and the summary line handed; the run's
    /// own session's log gets none. Mutations: draft the event for the run's own session; name the
    /// run's session in the payload; refuse every failed run; drop the summary.
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

        poster
            .post(
                run_id(),
                asking_session_id(),
                summary.map(|line| NonEmptyText::new(line.to_owned()).expect("the test's summary")),
            )
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

    /// The post's own write refuses a run still going and one parked on its failed step
    /// `workflow.invalidTransition`, and one no row answers to `workflow.run.notFound`, appending
    /// nothing. Mutations: drop the finished check from the write; leave its expected row count
    /// unset; drop the parked condition; answer every refusal by one code.
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
            .post(run_id(), asking_session_id(), None)
            .await
            .expect_err("the post is refused");

        match HandlerError::from(error) {
            HandlerError::Refused(refusal) => {
                assert_eq!(refusal.code, code);
            }
            other @ (HandlerError::Internal(_) | HandlerError::Canceled) => {
                panic!("expected a refusal, got {other:?}")
            }
        }
        assert_eq!(posted_events(&rows), Vec::new());
    }

    /// A chat's and an agent's runs post their results, a retry as the run it retries would, and
    /// no other run. Mutations: post for every mode; post every retry; post no agent run.
    #[rstest]
    #[case::chat(WorkflowRunMode::Chat, None, true)]
    #[case::agent(WorkflowRunMode::Agent, None, true)]
    #[case::retry_of_a_chat_run(WorkflowRunMode::Retry, Some(WorkflowRunMode::Chat), true)]
    #[case::retry_of_a_manual_run(WorkflowRunMode::Retry, Some(WorkflowRunMode::Manual), false)]
    #[case::manual(WorkflowRunMode::Manual, None, false)]
    #[case::trigger(WorkflowRunMode::Trigger, None, false)]
    #[case::webhook(WorkflowRunMode::Webhook, None, false)]
    #[case::sub_workflow(WorkflowRunMode::SubWorkflow, None, false)]
    fn which_runs_post_their_results(
        #[case] mode: WorkflowRunMode,
        #[case] retried_mode: Option<WorkflowRunMode>,
        #[case] posts: bool,
    ) {
        assert_eq!(run_posts_results(mode, retried_mode), posts);
    }
}
