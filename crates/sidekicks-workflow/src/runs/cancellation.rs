//! What a cancel does to a run's rows: the statements the engine's cancel writes in one unit of
//! work with the run's canceled event, and a projection rebuild applies from that event alone.

use std::borrow::Cow;
use std::sync::LazyLock;

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};

use crate::runs::record::end_run_row;
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
    /// Why it was canceled, where the canceling side says.
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
    format!(
        "UPDATE workflow_steps
  SET status = CASE WHEN status IN ({going}) THEN '{canceled}' ELSE status END,
      finished_at = CASE WHEN status IN ({going}) THEN @finished_at ELSE finished_at END,
      {CLEAR_WAIT_COLUMNS_SQL}
  WHERE workflow_run_id = @workflow_run_id"
    )
});

/// The statements that apply `cancellation`: the run's row ends `canceled` through
/// [`end_run_row`], its open wait on people closed, every step still running, waiting or held by
/// the memory gate reads `canceled` with the same end, and no step of the run keeps a wait cause,
/// wait start, resume instant, deadline, wait id or spent account. The write is refused, changing
/// nothing, unless the run is still going or parked on a failed step.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run engine's cancel, which writes them with the run's canceled event"
    )
)]
pub(crate) fn workflow_run_cancellation_statements(
    cancellation: &WorkflowRunCancellation,
) -> [WriteStatement; 2] {
    [
        end_run_row(
            cancellation.workflow_run_id,
            WorkflowRunStatus::Canceled,
            &cancellation.finished_at,
            cancellation.error.as_ref(),
        ),
        WriteStatement {
            sql: Cow::Borrowed(CANCEL_STEPS_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding(
                    "@workflow_run_id",
                    cancellation.workflow_run_id.text().as_str(),
                ),
                text_binding("@finished_at", cancellation.finished_at.as_str()),
            ]),
            expected_row_count: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, OptionalExtension};
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::workflow::run::id::WorkflowRunId;
    use sidekicks_contracts::workflow::run::status::{
        WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
    };
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};

    use super::{WorkflowRunCancellation, workflow_run_cancellation_statements};
    use crate::schema::schema_parts;
    use crate::test_rows::{TestStep, insert_run, insert_step, insert_workflow_version};

    const CANCELED_AT: &str = "2026-10-02T00:10:00.000Z";
    const ENDED_AT: &str = "2026-10-02T00:05:00.000Z";
    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e50";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e51";
    const WAITING_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e52";
    const ENDED_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e53";

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
            error: None,
        }
    }

    /// Mutation: drop the run's status guard, so the cancel overwrites the end of a run that has
    /// already ended and clears nothing less.
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

        writer
            .write(workflow_run_cancellation_statements(&cancellation(WAITING_RUN_ID)).into())
            .await
            .expect("a going run's cancel commits");
        let refused = writer
            .write(workflow_run_cancellation_statements(&cancellation(ENDED_RUN_ID)).into())
            .await;

        assert!(matches!(refused, Err(WriteError::Refused { .. })));
        assert_eq!(
            run_status_and_end(&rows, ENDED_RUN_ID),
            ("succeeded".to_owned(), Some(ENDED_AT.to_owned()))
        );
        assert_eq!(
            run_status_and_end(&rows, WAITING_RUN_ID),
            ("canceled".to_owned(), Some(CANCELED_AT.to_owned()))
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
            .write(workflow_run_cancellation_statements(&cancellation(WAITING_RUN_ID)).into())
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
