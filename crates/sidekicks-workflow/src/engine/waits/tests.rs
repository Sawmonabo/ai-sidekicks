use std::sync::Arc;
use std::time::{Duration, SystemTime};

use jiff::Timestamp;
use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::{Map, Value, json};
use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::{ComposedText, NonEmptyText};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::status::{
    WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::armed_instant::InstantJob as _;
use sidekicks_std::scheduler::test_wall_clock::{TEST_CLOCK_START, TestWallClock};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use tokio::sync::{mpsc, watch};

use super::{
    PERSON_WAIT_STATEMENT_CAPACITY, PersonWaitAnswer, PersonWaitDeadlines, PersonWaitRefusal,
    WaitingPersonStep, open_person_wait, settle_person_wait,
};
use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
use crate::kinds::{PersonAsk, StepFailure};
use crate::schema::schema_parts;
use crate::test_rows::{TEST_NODE_ID, TestStep, insert_run, insert_step, insert_workflow_version};

const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e50";
const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e51";
const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e52";
const OPENED_AT: &str = "2026-10-02T00:00:00.000Z";
const ANSWERED_AT: &str = "2026-10-02T00:00:05.000Z";
// A wait that should stay silent is given this long to show it does not.
const QUIET: Duration = Duration::from_millis(50);

fn instant(text: &str) -> WireInstant {
    WireInstant::try_from(text.to_owned()).expect("the test's instant")
}

fn prompt() -> ComposedText {
    ComposedText::new("Ship it?".to_owned()).expect("the test's prompt")
}

fn person(name: &str) -> WorkflowItem {
    WorkflowItem {
        json: AnyValue(json!({ "name": name })),
        binary: None,
        paired_item: None,
        error: None,
    }
}

// The test node's first attempt at `execution_index` in the test run.
fn test_step(execution_index: u32) -> WorkflowStepKey {
    serde_json::from_value(json!({
        "workflowRunId": RUN_ID, "nodeId": TEST_NODE_ID, "attempt": 1,
        "executionIndex": execution_index,
    }))
    .expect("the test's step key")
}

/// The answer settles its wait only when of its own kind, strictly before the deadline the wait
/// opened with. Kills: the approval's handles swapped, `>` in place of `>=` on the deadline, a late
/// answer taken, the kind unchecked.
#[rstest]
#[case::approved(
    PersonAsk::Approval { prompt: prompt() },
    PersonWaitAnswer::Approval(ApprovalDecision::Approved),
    ANSWERED_AT,
    Ok(json!([
        [
            {"json": {"name": "Ada"}, "pairedItem": {"item": 0}},
            {"json": {"name": "Bob"}, "pairedItem": {"item": 1}},
        ],
        [],
    ])),
)]
#[case::rejected(
    PersonAsk::Approval { prompt: prompt() },
    PersonWaitAnswer::Approval(ApprovalDecision::Rejected),
    ANSWERED_AT,
    Ok(json!([
        [],
        [
            {"json": {"name": "Ada"}, "pairedItem": {"item": 0}},
            {"json": {"name": "Bob"}, "pairedItem": {"item": 1}},
        ],
    ])),
)]
#[case::form(
    PersonAsk::Form { prompt: prompt(), input_schema: Map::new() },
    PersonWaitAnswer::Form(Map::from_iter([("email".to_owned(), json!("ada@example.com"))])),
    ANSWERED_AT,
    Ok(json!([[{"json": {"email": "ada@example.com"}, "pairedItem": {"item": 0}}]])),
)]
#[case::reply(
    PersonAsk::Reply { prompt: prompt() },
    PersonWaitAnswer::Reply(NonEmptyText::new("Ship it".to_owned()).expect("a reply")),
    ANSWERED_AT,
    Ok(json!([[{"json": {"reply": "Ship it"}, "pairedItem": {"item": 0}}]])),
)]
#[case::an_approval_for_a_form_wait(
    PersonAsk::Form { prompt: prompt(), input_schema: Map::new() },
    PersonWaitAnswer::Approval(ApprovalDecision::Approved),
    ANSWERED_AT,
    Err(PersonWaitRefusal::NotWaiting),
)]
#[case::at_the_deadline(
    PersonAsk::Approval { prompt: prompt() },
    PersonWaitAnswer::Approval(ApprovalDecision::Approved),
    "2026-10-02T00:00:10.000Z",
    Err(PersonWaitRefusal::NotWaiting),
)]
#[case::a_millisecond_before_the_deadline(
    PersonAsk::Approval { prompt: prompt() },
    PersonWaitAnswer::Approval(ApprovalDecision::Approved),
    "2026-10-02T00:00:09.999Z",
    Ok(json!([
        [
            {"json": {"name": "Ada"}, "pairedItem": {"item": 0}},
            {"json": {"name": "Bob"}, "pairedItem": {"item": 1}},
        ],
        [],
    ])),
)]
fn an_answer_settles_only_its_own_wait_before_its_deadline(
    #[case] ask: PersonAsk,
    #[case] answer: PersonWaitAnswer,
    #[case] answered_at: &str,
    #[case] expected: Result<Value, PersonWaitRefusal>,
) {
    let opened = open_person_wait(&ask, Some(Duration::from_secs(10)), instant(OPENED_AT))
        .expect("the wait opens");
    let waiting = WaitingPersonStep {
        step: test_step(0),
        wait_id: opened.wait_id,
        cause: opened.cause,
        deadline_at: opened.deadline_at,
    };
    let settled = settle_person_wait(
        &waiting,
        answer,
        &instant(answered_at),
        vec![person("Ada"), person("Bob")],
    )
    .map(|settlement| match settlement {
        StepSettlement::Completed { outputs, .. } => {
            serde_json::to_value(outputs).expect("the outputs write")
        }
        StepSettlement::Failed { .. }
        | StepSettlement::PersonWait { .. }
        | StepSettlement::AccountSpent { .. }
        | StepSettlement::Canceled { .. } => Value::Null,
    });

    assert_eq!(settled, expected);
}

// The test clock's start, moved on by `after`.
fn clock_instant(after: Duration) -> SystemTime {
    SystemTime::UNIX_EPOCH + TEST_CLOCK_START + after
}

// `at` in the stored form.
fn stored(at: SystemTime) -> String {
    let timestamp = Timestamp::try_from(at).expect("the test clock reads as a timestamp");
    WireInstant::from_timestamp(timestamp)
        .expect("the test clock is after year 0000")
        .as_str()
        .to_owned()
}

// Makes the wait of the step at `execution_index` begin at the clock's start and give up
// `deadline_after` later.
fn set_deadline(rows: &Connection, execution_index: u32, deadline_after: Duration) {
    rows.execute(
        "UPDATE workflow_steps SET wait_started_at = ?1, wait_deadline_at = ?2 \
         WHERE execution_index = ?3",
        params![
            stored(clock_instant(Duration::ZERO)),
            stored(clock_instant(deadline_after)),
            execution_index
        ],
    )
    .expect("the test sets a deadline");
}

async fn next_report(received: &mut mpsc::Receiver<StepReport>) -> StepReport {
    tokio::time::timeout(Duration::from_secs(10), received.recv())
        .await
        .expect("a report arrives")
        .expect("the clock still reports")
}

// The step a report names and the error it failed with, `null` for any other report.
fn reported_failure(report: StepReport) -> (WorkflowStepKey, Value) {
    let StepReportKind::Settled(StepSettlement::Failed {
        failure: StepFailure::Failed(error),
        ..
    }) = report.kind
    else {
        return (report.step, Value::Null);
    };
    (
        report.step,
        serde_json::to_value(error).expect("the error writes"),
    )
}

fn timed_out(limit_ms: u64) -> Value {
    json!({
        "message": "The step's wait passed its timeout",
        "nodeId": TEST_NODE_ID,
        "code": "workflow.step.timedOut",
        "details": {"cause": "stepTimeout", "limitMs": limit_ms},
    })
}

/// The clock arms at the earliest stored deadline, fails only the steps due by the instant it
/// fired at, once, and reaches the next only when the tick re-arms after the commit. Kills: the
/// deadline read from anything but the row, a fire that re-arms itself (a second report of the
/// first step), every waiting step failed at the first fire, the account wait read.
#[tokio::test]
async fn a_deadline_that_passed_fails_its_step_once_the_clock_reaches_it() {
    let database = TestDatabase::new(schema_parts());
    let rows = database.reader();
    insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Review");
    insert_run(
        &rows,
        RUN_ID,
        VERSION_ID,
        WorkflowRunStatus::Waiting,
        OPENED_AT,
        None,
    );
    let waits = [
        (WorkflowWaitCause::Approval, None),
        (WorkflowWaitCause::Form, None),
        (WorkflowWaitCause::Account, Some("account-one")),
    ];
    for (execution_index, (wait_cause, wait_account_id)) in (0..).zip(waits) {
        insert_step(
            &rows,
            RUN_ID,
            &TestStep {
                execution_index,
                status: WorkflowStepStatus::Waiting,
                wait_cause: Some(wait_cause),
                wait_account_id,
                resume_at: None,
            },
        );
    }
    set_deadline(&rows, 0, Duration::from_secs(10));
    set_deadline(&rows, 1, Duration::from_secs(20));
    let clock = Arc::new(TestWallClock::default());
    let wall_clock: Arc<TestWallClock> = Arc::clone(&clock);
    let scheduler = Arc::new(Scheduler::start(wall_clock, None, watch::channel(0).1));
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        PERSON_WAIT_STATEMENT_CAPACITY,
    ));
    let (reports, mut received) = mpsc::channel(8);
    let deadlines = PersonWaitDeadlines::new(Arc::clone(&scheduler), reads, reports);

    Arc::clone(&deadlines).rearm().await;
    assert_eq!(
        deadlines.armed.instant(),
        Some(clock_instant(Duration::from_secs(10)))
    );
    assert!(received.try_recv().is_err(), "nothing is due yet");

    clock.set_now(clock_instant(Duration::from_secs(15)));
    assert_eq!(
        reported_failure(next_report(&mut received).await),
        (test_step(0), timed_out(10_000))
    );

    clock.set_now(clock_instant(Duration::from_secs(25)));
    tokio::time::sleep(QUIET).await;
    assert!(received.try_recv().is_err(), "the fire armed nothing again");

    // The commit that fails the first step clears its wait; the tick re-arms after it.
    rows.execute(
        "UPDATE workflow_steps SET status = ?1, finished_at = ?2, wait_cause = NULL, \
         wait_deadline_at = NULL, wait_started_at = NULL, wait_id = NULL \
         WHERE execution_index = 0",
        params![
            <&'static str>::from(WorkflowStepStatus::Failed),
            stored(clock_instant(Duration::from_secs(15)))
        ],
    )
    .expect("the test settles the first step");
    Arc::clone(&deadlines).rearm().await;
    assert_eq!(
        reported_failure(next_report(&mut received).await),
        (test_step(1), timed_out(20_000))
    );
    tokio::time::sleep(QUIET).await;
    assert!(
        received.try_recv().is_err(),
        "the account wait has no deadline"
    );
    scheduler.stop().await.expect("the scheduler stops");
}
