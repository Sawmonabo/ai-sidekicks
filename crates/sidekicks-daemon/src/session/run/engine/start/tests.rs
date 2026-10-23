use futures::FutureExt;
use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::open_log;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::registry::test_provider;
use crate::provider::driver::run_control::DriverRunRefusal;
use crate::queue::error::QueueError;
use crate::session::run::engine::tests::{
    DRIVER_HOLD, SETTLE_WAIT, held_driver, test_engine, turn_start,
};
use crate::session::run::start_request::RunStartRequest;
use crate::session::run::state_change::{RunStateChange, RunStateEntry};
use sidekicks_contracts::wire::id::mint_uuid_v7;

// Killed by recording a driver's refused start as a provider failure, which drops the refusal's
// model and sentence, or by missing the refusal behind the queue's error that carries it.
#[tokio::test]
async fn a_start_the_driver_refused_fails_the_run_as_the_daemons_refusal() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    database
        .reader()
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version)
             VALUES (?1, ?2, 'queued', 0)",
            params![run_id.text().as_str(), test_session_id().text().as_str()],
        )
        .expect("the test queues the run");
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let engine = test_engine(&database, log.service, home.path());
    let refused_driver = |_posture| {
        let refusal = DriverRunRefusal {
            model: FreeFormText::new("claude-opus-4-7".to_owned()).expect("the model fits"),
            sentence: "screen.png is too large".to_owned(),
        };
        let error = QueueError::Driver(DriverError::RunRefused(refusal));
        async move { Err(Box::new(error) as Box<dyn std::error::Error + Send + Sync>) }.boxed()
    };

    engine
        .start_run(RunStartRequest {
            turn: turn_start(run_id, refused_driver),
            queue_item: None,
            provider: test_provider(),
            output_speed: None,
            running_statements: None,
        })
        .await
        .expect_err("a refused start fails");

    let payload: String = database
        .reader()
        .query_row(
            "SELECT payload FROM session_events WHERE run_id = ?1 AND type = 'agent.run.failed'",
            [run_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the run's failure is written");
    let payload: Value = serde_json::from_str(&payload).expect("the payload is JSON");
    assert_eq!(payload["failureCategory"], "refused");
    assert_eq!(
        payload["failureCause"],
        json!({
            "cause": "refused",
            "origin": "daemon",
            "model": "claude-opus-4-7",
            "sentence": "screen.png is too large",
        })
    );
    assert_eq!(payload.get("providerFailureDetail"), None);
}

// Killed by dropping the report's wait on the starting run's settlement: the report then reads
// the run `starting`, which may not move to `waitingForApproval`, and is refused before the
// start's `running` write lands.
#[tokio::test]
async fn a_provider_report_during_a_start_waits_for_its_running_write() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    {
        let connection = database.reader();
        connection
            .execute(
                "INSERT INTO runs (run_id, session_id, state, run_version)
                 VALUES (?1, ?2, 'queued', 0)",
                params![run_id.text().as_str(), session_id.text().as_str()],
            )
            .expect("the test queues the run");
    }
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let engine = test_engine(&database, log.service, home.path());

    let (start_driver, driver_has_started, release_driver) = held_driver();
    let request = RunStartRequest {
        turn: turn_start(run_id, start_driver),
        queue_item: None,
        provider: test_provider(),
        output_speed: None,
        running_statements: None,
    };

    let report_during_start = async {
        driver_has_started
            .await
            .expect("the driver's start is reached");
        let report = engine.apply_provider_state_change(
            RunStateChange::new(run_id, RunStateEntry::WaitingForApproval),
            None,
        );
        let release = async {
            tokio::time::sleep(DRIVER_HOLD).await;
            release_driver
                .send(())
                .expect("the start still waits in its driver");
        };
        tokio::join!(report, release).0
    };
    let (started, reported) = tokio::time::timeout(SETTLE_WAIT, async {
        tokio::join!(Box::pin(engine.start_run(request)), report_during_start)
    })
    .await
    .expect("the report and the start settle without waiting on each other");

    started.expect("the start writes its run running");
    let reported = reported.expect("the report is written after the start's running write");
    assert_eq!(
        reported.written.state,
        sidekicks_contracts::run::state::RunState::WaitingForApproval
    );
    let types: Vec<String> = database
        .reader()
        .prepare("SELECT type FROM session_events WHERE run_id = ?1 ORDER BY sequence")
        .expect("the test reads the run's events")
        .query_map([run_id.text().as_str()], |row| row.get(0))
        .expect("the run's events read")
        .collect::<Result<_, _>>()
        .expect("each type reads");
    assert_eq!(
        types,
        [
            "agent.run.starting",
            "agent.run.running",
            "agent.run.waitingForApproval"
        ]
    );
}
