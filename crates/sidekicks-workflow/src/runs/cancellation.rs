//! What a cancel does to a run's rows: the statements the engine's cancel writes in one unit of
//! work with the run's canceled event, and a projection rebuild applies from that event alone,
//! beside the events the cancel appends after it, one closing each question its waits held and the
//! results of a run that posts them, and the approval cards it withdraws once the write commits;
//! and the first cancel's event, which a second cancel of the same run answers.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::question::{QuestionWaitOutcome, QuestionWaitSettledPayload};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::run::control::WorkflowCancelReason;
use sidekicks_contracts::workflow::run::events::WorkflowRunCanceledPayload;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{
    WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
};
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseCancellationReason;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};

use crate::engine::results::{results_posted_event, run_posts_results};
use crate::engine::waits::step_key;
use crate::runs::record::{FIRST_NON_RETRY_MODE_SQL, end_run_statements};
use crate::runs::step_rows::CLEAR_WAIT_COLUMNS_SQL;

/// A cancel as the run's rows record it.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run engine's cancel, which writes them with the run's canceled event"
    )
)]
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WorkflowRunCancellation {
    /// The run canceled.
    pub(crate) workflow_run_id: WorkflowRunId,
    /// When it ended, in the stored form.
    pub(crate) finished_at: WireInstant,
    /// The person's reason, where one was given; a chain's `Stop them all` gives none.
    pub(crate) reason: Option<WorkflowCancelReason>,
    /// The run's error the cancel stores, carrying the reason as its message.
    pub(crate) error: Option<WorkflowStepError>,
}

// Run-scoped rather than per waiting step: parallel branches wait independently, so every step row
// of the run is cleared, and a step still going reads canceled while a pending one stays pending.
// SQLite evaluates every SET expression against the row as it was, so each CASE reads the old
// status.
static CANCEL_STEPS_SQL: LazyLock<String> = LazyLock::new(|| {
    let going = sql_list_of(
        [
            WorkflowStepStatus::Running,
            WorkflowStepStatus::Waiting,
            WorkflowStepStatus::WaitingMemory,
        ]
        .map(<&'static str>::from),
    );
    let canceled = <&'static str>::from(WorkflowStepStatus::Canceled);
    let run_canceled = <&'static str>::from(WorkflowPhaseCancellationReason::RunCanceled);
    format!(
        "UPDATE workflow_steps
  SET status = CASE WHEN status IN ({going}) THEN '{canceled}' ELSE status END,
      finished_at = CASE WHEN status IN ({going}) THEN @finished_at ELSE finished_at END,
      cancellation_reason = CASE WHEN status IN ({going}) THEN '{run_canceled}'
        ELSE cancellation_reason END,
      {CLEAR_WAIT_COLUMNS_SQL}
  WHERE workflow_run_id = @workflow_run_id"
    )
});

/// What a cancel of a run the engine's tick does not hold writes beside its
/// `workflow.run.canceled`.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run engine's cancel, which writes them with the run's canceled event"
    )
)]
pub(crate) struct WorkflowRunCancellationWrite {
    /// The session whose log takes the write.
    pub(crate) session_id: SessionId,
    /// The statements that apply the cancel.
    pub(crate) statements: [WriteStatement; 4],
    /// The run's `workflow.run.canceled`, carrying the cancel's reason and error.
    pub(crate) canceled: SessionEvent,
    /// One `question.wait.settled` `ended` for each form or reply wait the cancel ends, appended
    /// after its canceled event in the same write.
    pub(crate) questions_settled: Vec<SessionEvent>,
    /// The run's results event, with its summary line, appended after its canceled event in the
    /// same write, for a run whose mode posts its results.
    pub(crate) results_posted: Option<SessionEvent>,
    /// The approval waits the cancel ends, each with its step, whose cards are withdrawn once the
    /// write commits.
    pub(crate) withdrawn_cards: Vec<(WorkflowStepKey, UuidTextForm)>,
    /// Whether the run held an execution context, which the write releases, so its session is
    /// swept out of a removed tree once the write commits.
    pub(crate) is_bound: bool,
}

// The session a run's results post into, its mode and its summary line, the definition and
// version its events name, how the first run of its retries that is not a retry was started, and
// whether it holds an execution context.
static RUN_CANCELLATION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run.session_id, run.mode, run.summary,
    version.definition_id, run.workflow_version_id, {first_mode},
    EXISTS (SELECT 1 FROM run_execution_contexts AS context
             WHERE context.run_id = run.id AND context.released_at IS NULL)
  FROM workflow_runs AS run
  JOIN workflow_versions AS version ON version.id = run.workflow_version_id
  WHERE run.id = @run_id",
        first_mode = FIRST_NON_RETRY_MODE_SQL.as_str(),
    )
});

// The step, its wait and the wait's cause of each step of a run waiting under a wait of its own,
// in step order.
static OPEN_WAITS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT workflow_run_id, node_id, attempt, execution_index, wait_id, wait_cause
  FROM workflow_steps
  WHERE workflow_run_id = ?1 AND status = '{waiting}' AND wait_id IS NOT NULL
  ORDER BY execution_index",
        waiting = <&'static str>::from(WorkflowStepStatus::Waiting),
    )
});

// The first `workflow.run.canceled` of a run in its session's log; a run is canceled once.
const CANCELED_EVENT_SQL: &str = "SELECT id FROM session_events
  WHERE session_id = ?1 AND workflow_run_id = ?2 AND type = 'workflow.run.canceled'
  ORDER BY sequence LIMIT 1";

/// The write of `cancellation`, the run's session, mode, summary, definition, version and open
/// waits read on `connection`; `None` when no row has the run. Its `workflow.run.canceled` carries
/// the cancel's reason and error, and each form or reply wait the cancel ends has its question
/// settled `ended` after it, while each approval wait's card is named for withdrawal once the write
/// commits, as the tick's ending does both. Its statements end the run's row `canceled` through
/// [`end_run_statements`], its open wait on people closed, its execution context released and the
/// workspace it owns archived, every step still running, waiting or held by the memory gate reads
/// `canceled` with the same end, and no step of the run keeps a wait cause, wait start, resume
/// instant, deadline, wait id or spent account; the write is refused, changing nothing, unless the
/// run is still going or parked on a failed step. Its writer tells the session's binder once the
/// write commits, as the tick's ending does. A run whose mode posts its results posts them as its
/// ending in the tick would, a retry as the first run of its retries that is not a retry would.
/// Fails as the read does.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run engine's cancel, which writes them with the run's canceled event"
    )
)]
pub(crate) fn workflow_run_cancellation_statements(
    connection: &Connection,
    cancellation: &WorkflowRunCancellation,
) -> rusqlite::Result<Option<WorkflowRunCancellationWrite>> {
    let workflow_run_id = cancellation.workflow_run_id;
    let run_text = workflow_run_id.text();
    let Some((
        session_id,
        mode,
        summary,
        definition_id,
        workflow_version_id,
        retried_mode,
        is_bound,
    )) = connection
        .prepare_cached(RUN_CANCELLATION_SQL.as_str())?
        .query_row(named_params! { "@run_id": run_text.as_str() }, |row| {
            Ok((
                text_column(row, 0, |text| SessionId::new(&text))?,
                text_column(row, 1, closed_word::<WorkflowRunMode>)?,
                optional_text_column(row, 2, closed_word::<NonEmptyText>)?,
                text_column(row, 3, |text| WorkflowDefinitionId::new(&text))?,
                text_column(row, 4, |text| WorkflowVersionId::new(&text))?,
                optional_text_column(row, 5, closed_word::<WorkflowRunMode>)?,
                row.get::<_, bool>(6)?,
            ))
        })
        .optional()?
    else {
        return Ok(None);
    };
    let mut questions_settled = Vec::new();
    let mut withdrawn_cards = Vec::new();
    let mut waits = connection.prepare_cached(OPEN_WAITS_SQL.as_str())?;
    for wait in waits.query_map([run_text.as_str()], |row| {
        Ok((
            step_key(row)?,
            text_column(row, 4, |text| UuidTextForm::new(&text))?,
            text_column(row, 5, closed_word::<WorkflowWaitCause>)?,
        ))
    })? {
        let (step, wait_id, cause) = wait?;
        match cause {
            WorkflowWaitCause::Form | WorkflowWaitCause::Reply => {
                questions_settled.push(SessionEvent::QuestionWaitSettled(
                    QuestionWaitSettledPayload {
                        session_id,
                        wait_id,
                        outcome: QuestionWaitOutcome::Ended,
                    },
                ));
            }
            WorkflowWaitCause::Approval => withdrawn_cards.push((step, wait_id)),
            WorkflowWaitCause::Account | WorkflowWaitCause::Chain => {}
        }
    }
    let canceled = SessionEvent::WorkflowRunCanceled(WorkflowRunCanceledPayload {
        session_id,
        workflow_run_id,
        definition_id,
        workflow_version_id,
        reason: cancellation.reason.clone(),
        error: cancellation.error.clone(),
    });
    let results_posted = run_posts_results(mode, retried_mode)
        .then(|| results_posted_event(session_id, workflow_run_id, summary));
    Ok(Some(WorkflowRunCancellationWrite {
        session_id,
        statements: cancellation_statements(cancellation),
        canceled,
        questions_settled,
        results_posted,
        withdrawn_cards,
        is_bound,
    }))
}

/// The id of the first `workflow.run.canceled` of the run `workflow_run_id` in the log of
/// `session_id`, its session, read on `connection`; `None` when the log holds none.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run controls, which answer a second cancel with it"
    )
)]
pub(crate) fn read_canceled_event_id(
    connection: &Connection,
    session_id: SessionId,
    workflow_run_id: WorkflowRunId,
) -> rusqlite::Result<Option<String>> {
    connection
        .prepare_cached(CANCELED_EVENT_SQL)?
        .query_row(
            [session_id.text().as_str(), workflow_run_id.text().as_str()],
            |row| row.get(0),
        )
        .optional()
}

/// The statements that apply `cancellation`, as [`workflow_run_cancellation_statements`] says.
fn cancellation_statements(cancellation: &WorkflowRunCancellation) -> [WriteStatement; 4] {
    let [end_row, release_context, archive_workspace] = end_run_statements(
        cancellation.workflow_run_id,
        WorkflowRunStatus::Canceled,
        &cancellation.finished_at,
        cancellation.error.as_ref(),
    );
    [
        end_row,
        release_context,
        archive_workspace,
        cancel_steps_statement(cancellation.workflow_run_id, &cancellation.finished_at),
    ]
}

/// The statement that cancels every step of run `workflow_run_id` still running, waiting or held
/// by the memory gate at `finished_at` and empties every step's wait columns, from the run alone,
/// so a rebuild applies it from `workflow.run.canceled` as the cancel's write does.
pub(crate) fn cancel_steps_statement(
    workflow_run_id: WorkflowRunId,
    finished_at: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(CANCEL_STEPS_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@workflow_run_id", workflow_run_id.text().as_str()),
            text_binding("@finished_at", finished_at.as_str()),
        ]),
        expected_row_count: None,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use rusqlite::{Connection, OptionalExtension};
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::text::NonEmptyText;
    use sidekicks_contracts::workflow::run::id::WorkflowRunId;
    use sidekicks_contracts::workflow::run::status::{
        WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
    };
    use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
    use sidekicks_store::database::statement::WriteStatement;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};

    use super::{WorkflowRunCancellation, workflow_run_cancellation_statements};
    use crate::engine::results::results_posted_event;
    use crate::schema::schema_parts;
    use crate::test_rows::{
        TEST_SESSION_ID, TestStep, execution_context_released_at, insert_live_execution_context,
        insert_run, insert_step, insert_workflow_version,
    };

    const CANCELED_AT: &str = "2026-10-02T00:10:00.000Z";
    const ENDED_AT: &str = "2026-10-02T00:05:00.000Z";
    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e50";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e51";
    const WAITING_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e52";
    const ENDED_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e53";
    const RETRIED_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e54";

    // A step's status, end and every wait column, as the row holds them.
    type StepRow = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );

    fn step_rows(connection: &Connection, run_id: &str) -> Vec<StepRow> {
        connection
            .prepare(
                "SELECT status, finished_at, wait_cause, resume_at, wait_deadline_at, \
                 wait_account_id, wait_started_at FROM workflow_steps \
                 WHERE workflow_run_id = ?1 ORDER BY execution_index",
            )
            .expect("the test reads the steps")
            .query_map([run_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })
            .expect("the test reads the steps")
            .collect::<rusqlite::Result<_>>()
            .expect("the steps read")
    }

    fn run_status_and_end(connection: &Connection, run_id: &str) -> (String, Option<String>) {
        connection
            .query_row(
                "SELECT status, finished_at FROM workflow_runs WHERE id = ?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .expect("the test reads the run")
            .expect("the run is stored")
    }

    fn cancellation(run_id: &str) -> WorkflowRunCancellation {
        WorkflowRunCancellation {
            workflow_run_id: WorkflowRunId::new(run_id).expect("the test's run id"),
            finished_at: WireInstant::try_from(CANCELED_AT.to_owned()).expect("an instant"),
            reason: None,
            error: None,
        }
    }

    /// The statements of the cancel of `run_id`, its row read on `rows`.
    fn statements(rows: &Connection, run_id: &str) -> Vec<WriteStatement> {
        workflow_run_cancellation_statements(rows, &cancellation(run_id))
            .expect("the run's row reads")
            .expect("the run is stored")
            .statements
            .into()
    }

    /// A chat run's cancel appends its results event after its canceled event, naming the run's
    /// session and summary line, a manual run's appends none, a retry's posts as the run it
    /// retries would, and a run no row has answers no write. Mutations: post for every mode; post
    /// for none; drop the summary; read no retried mode.
    #[rstest]
    #[case::chat(WorkflowRunMode::Chat, None, true)]
    #[case::manual(WorkflowRunMode::Manual, None, false)]
    #[case::retry_of_a_chat(WorkflowRunMode::Retry, Some(WorkflowRunMode::Chat), true)]
    #[case::retry_of_a_manual(WorkflowRunMode::Retry, Some(WorkflowRunMode::Manual), false)]
    fn a_cancel_posts_the_results_of_a_run_that_posts_them(
        #[case] mode: WorkflowRunMode,
        #[case] retried_mode: Option<WorkflowRunMode>,
        #[case] posts: bool,
    ) {
        let database = TestDatabase::new(schema_parts());
        let rows = database.opener()().expect("the opener makes the test database");
        insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Fan out");
        insert_run(
            &rows,
            WAITING_RUN_ID,
            VERSION_ID,
            WorkflowRunStatus::Running,
            "2026-10-02T00:00:00.000Z",
            None,
        );
        let retried_run_id = retried_mode.map(|retried_mode| {
            insert_run(
                &rows,
                RETRIED_RUN_ID,
                VERSION_ID,
                WorkflowRunStatus::Succeeded,
                "2026-10-01T00:00:00.000Z",
                Some(ENDED_AT),
            );
            rows.execute(
                "UPDATE workflow_runs SET mode = ?1 WHERE id = ?2",
                [<&'static str>::from(retried_mode), RETRIED_RUN_ID],
            )
            .expect("the test sets the retried run's mode");
            RETRIED_RUN_ID
        });
        rows.execute(
            "UPDATE workflow_runs SET mode = ?1, retried_run_id = ?2, \
             summary = 'Shipped three fixes.' WHERE id = ?3",
            rusqlite::params![<&'static str>::from(mode), retried_run_id, WAITING_RUN_ID],
        )
        .expect("the test sets the run's mode and summary");

        let write = workflow_run_cancellation_statements(&rows, &cancellation(WAITING_RUN_ID))
            .expect("the run's row reads")
            .expect("the run is stored");
        let missing = workflow_run_cancellation_statements(&rows, &cancellation(ENDED_RUN_ID))
            .expect("the read runs");

        let summary = NonEmptyText::new("Shipped three fixes.".to_owned()).expect("a summary");
        let expected = posts.then(|| {
            results_posted_event(
                SessionId::new(TEST_SESSION_ID).expect("the test's session"),
                WorkflowRunId::new(WAITING_RUN_ID).expect("the test's run id"),
                Some(summary),
            )
        });
        assert_eq!(write.results_posted, expected);
        assert!(missing.is_none(), "no row has the run");
    }

    /// The cancel's write also releases the going run's execution context at its end. Mutations:
    /// drop the run's status guard, so the cancel overwrites the end of a run that has already
    /// ended and clears nothing less; drop the context's release from the run's end.
    #[tokio::test]
    async fn a_cancel_clears_every_wait_of_a_going_run_and_never_touches_an_ended_one() {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens the test database");
        let rows = database.reader();
        insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Fan out");
        insert_run(
            &rows,
            WAITING_RUN_ID,
            VERSION_ID,
            WorkflowRunStatus::Waiting,
            "2026-10-02T00:00:00.000Z",
            None,
        );
        let waits = [
            (WorkflowStepStatus::Succeeded, None, None, None),
            (
                WorkflowStepStatus::Waiting,
                Some(WorkflowWaitCause::Account),
                Some("account-one"),
                Some("2026-10-02T05:00:00.000Z"),
            ),
            (
                WorkflowStepStatus::Waiting,
                Some(WorkflowWaitCause::Approval),
                None,
                None,
            ),
            (WorkflowStepStatus::Pending, None, None, None),
        ];
        for (execution_index, (status, wait_cause, wait_account_id, resume_at)) in (0..).zip(waits)
        {
            insert_step(
                &rows,
                WAITING_RUN_ID,
                &TestStep {
                    execution_index,
                    status,
                    wait_cause,
                    wait_account_id,
                    resume_at,
                },
            );
        }
        insert_run(
            &rows,
            ENDED_RUN_ID,
            VERSION_ID,
            WorkflowRunStatus::Succeeded,
            "2026-10-02T00:00:00.000Z",
            Some(ENDED_AT),
        );
        insert_live_execution_context(&rows, WAITING_RUN_ID, TEST_SESSION_ID);

        writer
            .write(statements(&rows, WAITING_RUN_ID))
            .await
            .expect("a going run's cancel commits");
        let refused = writer.write(statements(&rows, ENDED_RUN_ID)).await;

        assert!(matches!(refused, Err(WriteError::Refused { .. })));
        assert_eq!(
            run_status_and_end(&rows, ENDED_RUN_ID),
            ("succeeded".to_owned(), Some(ENDED_AT.to_owned()))
        );
        assert_eq!(
            run_status_and_end(&rows, WAITING_RUN_ID),
            ("canceled".to_owned(), Some(CANCELED_AT.to_owned()))
        );
        assert_eq!(
            execution_context_released_at(&rows, WAITING_RUN_ID),
            Some(CANCELED_AT.to_owned())
        );
        let canceled = Some(CANCELED_AT.to_owned());
        let settled = |status: &str, finished_at: Option<String>| {
            (status.to_owned(), finished_at, None, None, None, None, None)
        };
        assert_eq!(
            step_rows(&rows, WAITING_RUN_ID),
            vec![
                settled("succeeded", None),
                settled("canceled", canceled.clone()),
                settled("canceled", canceled),
                settled("pending", None),
            ]
        );
    }
    /// A cancel of a run waiting on people since 00:07:30.250, 1,000 ms of earlier waits counted,
    /// closes that wait into the total at the cancel's end and leaves no wait open. Mutations: drop
    /// the close, so the row keeps its open wait and the write is refused; add the wait in whole
    /// seconds; leave the earlier total out.
    #[tokio::test]
    async fn a_cancel_closes_the_runs_open_wait_on_people() {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens the test database");
        let rows = database.reader();
        insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Fan out");
        insert_run(
            &rows,
            WAITING_RUN_ID,
            VERSION_ID,
            WorkflowRunStatus::Waiting,
            "2026-10-02T00:00:00.000Z",
            None,
        );
        rows.execute(
            "UPDATE workflow_runs SET person_wait_since = '2026-10-02T00:07:30.250Z', \
             person_wait_ms = 1000 WHERE id = ?1",
            [WAITING_RUN_ID],
        )
        .expect("the test opens the run's wait on people");

        writer
            .write(statements(&rows, WAITING_RUN_ID))
            .await
            .expect("a waiting run's cancel commits");

        let person_wait: (Option<String>, i64) = rows
            .query_row(
                "SELECT person_wait_since, person_wait_ms FROM workflow_runs WHERE id = ?1",
                [WAITING_RUN_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the test reads the run");
        assert_eq!(person_wait, (None, 1_000 + 149_750));
        assert_eq!(
            run_status_and_end(&rows, WAITING_RUN_ID),
            ("canceled".to_owned(), Some(CANCELED_AT.to_owned()))
        );
    }
}
