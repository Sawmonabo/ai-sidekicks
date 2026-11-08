use std::sync::Arc;
use std::time::{Duration, SystemTime};

use jiff::Timestamp;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
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

use super::{ENGINE_DEADLINE_STATEMENT_CAPACITY, EngineDeadlines};
use crate::engine::ports::WorkflowRunLimits;
use crate::engine::ports::run_limits::ScriptedRunLimits;
use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
use crate::kinds::StepFailure;
use crate::schema::schema_parts;
use crate::test_rows::{TEST_NODE_ID, TestStep, insert_run, insert_step, insert_workflow_version};
use sidekicks_contracts::daemon::config::RunTimeLimitMinutes;

const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e50";
const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e51";
const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e52";
const OPENED_AT: &str = "2026-10-02T00:00:00.000Z";
// A wait that should stay silent is given this long to show it does not.
const QUIET: Duration = Duration::from_millis(50);

// The test node's first attempt at `execution_index` in the test run.
fn test_step(execution_index: u32) -> WorkflowStepKey {
    serde_json::from_value(json!({
        "workflowRunId": RUN_ID, "nodeId": TEST_NODE_ID, "attempt": 1,
        "executionIndex": execution_index,
    }))
    .expect("the test's step key")
}

// Run limits with no limit set.
fn no_limits() -> Arc<dyn WorkflowRunLimits> {
    Arc::new(ScriptedRunLimits::default())
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

/// A dropped run's stored wait stays off the clock: the clock arms at the next run's deadline and
/// reports only that run's step once the clock passes both. Kills: the earliest read ignoring the
/// skip, which arms the dropped run's deadline; the due read reporting the dropped run's step.
#[tokio::test]
async fn a_dropped_runs_deadline_leaves_the_clock() {
    const DROPPED_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e53";
    let database = TestDatabase::new(schema_parts());
    let rows = database.opener()().expect("the test creates its database");
    insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Review");
    // Wait ids come from the execution index and are unique, so the two runs' indexes differ.
    for (run_id, execution_index, deadline_after) in [(DROPPED_RUN_ID, 0, 10), (RUN_ID, 1, 20)] {
        insert_run(
            &rows,
            run_id,
            VERSION_ID,
            WorkflowRunStatus::Waiting,
            OPENED_AT,
            None,
        );
        insert_step(
            &rows,
            run_id,
            &TestStep {
                execution_index,
                status: WorkflowStepStatus::Waiting,
                wait_cause: Some(WorkflowWaitCause::Approval),
                wait_account_id: None,
                resume_at: None,
            },
        );
        set_deadline(&rows, execution_index, Duration::from_secs(deadline_after));
    }
    let clock = Arc::new(TestWallClock::default());
    let wall_clock: Arc<TestWallClock> = Arc::clone(&clock);
    let scheduler = Arc::new(Scheduler::start(wall_clock, None, watch::channel(0).1));
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        ENGINE_DEADLINE_STATEMENT_CAPACITY,
    ));
    let (reports, mut received) = mpsc::channel(8);
    let deadlines = EngineDeadlines::new(scheduler, reads, reports, no_limits());

    deadlines.skip_run(WorkflowRunId::new(DROPPED_RUN_ID).expect("the test's run id"));
    Arc::clone(&deadlines).rearm().await;
    assert_eq!(
        deadlines.armed.instant(),
        Some(clock_instant(Duration::from_secs(20)))
    );

    clock.set_now(clock_instant(Duration::from_secs(15)));
    tokio::time::sleep(QUIET).await;
    assert!(received.try_recv().is_err(), "nothing is due yet");
    clock.set_now(clock_instant(Duration::from_secs(25)));
    assert_eq!(
        reported_failure(next_report(&mut received).await),
        (test_step(1), timed_out(20_000))
    );
    tokio::time::sleep(QUIET).await;
    assert!(
        received.try_recv().is_err(),
        "the dropped run's step is not reported"
    );
}

/// The clock arms at the earliest stored deadline, fails only the steps due by the instant it
/// fired at, once, and reaches the next only when the tick re-arms after the commit. Kills: the
/// deadline read from anything but the row, a fire that re-arms itself (a second report of the
/// first step), every waiting step failed at the first fire, the account wait read.
#[tokio::test]
async fn a_deadline_that_passed_fails_its_step_once_the_clock_reaches_it() {
    let database = TestDatabase::new(schema_parts());
    let rows = database.opener()().expect("the test creates its database");
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
        ENGINE_DEADLINE_STATEMENT_CAPACITY,
    ));
    let (reports, mut received) = mpsc::channel(8);
    let deadlines = EngineDeadlines::new(Arc::clone(&scheduler), reads, reports, no_limits());

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
    scheduler
        .stop(tokio::time::Instant::now() + Duration::from_secs(60))
        .await
        .expect("the scheduler stops");
}

/// Which of the runs the cap counts the test stores.
#[derive(Clone, Copy)]
enum CountedRun {
    Running,
    Waiting,
    FailedPark,
}

/// The earliest cap counts a running, a waiting and a failed-parked run at its start, the limit
/// and its person-wait time, and skips a finished run, a run waiting on a person and a dropped
/// run, each started earlier. Kills: the `finished_at IS NULL` filter dropped; the going statuses
/// read in place of it; `person_wait_ms` left out.
#[rstest::rstest]
#[case::running(CountedRun::Running)]
#[case::waiting(CountedRun::Waiting)]
#[case::failed_park(CountedRun::FailedPark)]
#[tokio::test]
async fn the_earliest_cap_counts_every_unfinished_run_not_skipped(#[case] counted: CountedRun) {
    const FINISHED_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e54";
    const PERSON_WAIT_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e55";
    const DROPPED_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e56";
    let database = TestDatabase::new(schema_parts());
    let rows = database.opener()().expect("the test creates its database");
    insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Review");
    let earlier = stored(clock_instant(Duration::ZERO));
    let later = stored(clock_instant(Duration::from_secs(60)));
    let status = match counted {
        CountedRun::Running => WorkflowRunStatus::Running,
        CountedRun::Waiting => WorkflowRunStatus::Waiting,
        CountedRun::FailedPark => WorkflowRunStatus::Failed,
    };
    insert_run(&rows, RUN_ID, VERSION_ID, status, &later, None);
    insert_run(
        &rows,
        FINISHED_RUN_ID,
        VERSION_ID,
        WorkflowRunStatus::Succeeded,
        &earlier,
        Some(&later),
    );
    insert_run(
        &rows,
        PERSON_WAIT_RUN_ID,
        VERSION_ID,
        WorkflowRunStatus::Waiting,
        &earlier,
        None,
    );
    insert_run(
        &rows,
        DROPPED_RUN_ID,
        VERSION_ID,
        WorkflowRunStatus::Running,
        &earlier,
        None,
    );
    rows.execute(
        "UPDATE workflow_runs SET person_wait_ms = 5000 WHERE id = ?1",
        params![RUN_ID],
    )
    .expect("the test sets the run's person-wait time");
    rows.execute(
        "UPDATE workflow_runs SET person_wait_since = ?1 WHERE id = ?2",
        params![earlier, PERSON_WAIT_RUN_ID],
    )
    .expect("the test opens a person wait");
    let clock = Arc::new(TestWallClock::default());
    let wall_clock: Arc<TestWallClock> = Arc::clone(&clock);
    let scheduler = Arc::new(Scheduler::start(wall_clock, None, watch::channel(0).1));
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        ENGINE_DEADLINE_STATEMENT_CAPACITY,
    ));
    let (reports, _received) = mpsc::channel(8);
    let limits = Arc::new(ScriptedRunLimits::default());
    limits.set_run_time_limit(RunTimeLimitMinutes::new(30));
    let deadlines = EngineDeadlines::new(scheduler, reads, reports, limits);
    deadlines.skip_run(WorkflowRunId::new(DROPPED_RUN_ID).expect("the test's run id"));

    Arc::clone(&deadlines).rearm().await;

    assert_eq!(
        deadlines.armed.instant(),
        Some(clock_instant(Duration::from_secs(60 + 30 * 60 + 5)))
    );
}
