use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::FutureExt;
use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::contract::DriverError;
use sidekicks_provider::driver::registry::test_provider;
use sidekicks_provider::driver::run_control::DriverRunRefusal;
use sidekicks_provider::run::posture::compose_execution_posture;
use sidekicks_provider::run::start_request::DriverStep;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_std::file::bounded_read::hold_reads_of;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::open_log;

use crate::questions::schema::schema_parts;
use crate::run::engine::test_fixture::{end_run_aside, test_engine};
use crate::run::engine::tests::{
    DRIVER_HOLD, SETTLE_WAIT, continue_request, held_driver, turn_start,
};
use crate::run::engine::{InterruptRoute, RunEngineError};
use crate::run::refusals::RunRefusal;
use crate::run::start_request::RunStartRequest;
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions};

// Killed by recording a driver's refused start as a provider failure, which drops the refusal's
// model and sentence, or by reading only the driver's error and missing the refusal it carries.
#[tokio::test]
async fn a_start_the_driver_refused_fails_the_run_as_the_daemons_refusal() {
    let database = TestDatabase::new(schema_parts());
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
        let error = DriverError::RunRefused(refusal);
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
    let database = TestDatabase::new(schema_parts());
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

// Killed by refusing the start of a run that ended during its gate without letting go what the
// gate took after that end: the run's resolved posture would stay held for the daemon's life.
#[tokio::test]
async fn a_run_that_ended_during_its_gate_lets_go_its_resolved_posture() {
    let database = TestDatabase::new(schema_parts());
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
    let git_folder = home.path().join("repo.git");
    std::fs::create_dir(&git_folder).expect("the git folder is made");
    let engine = test_engine(&database, log.service, home.path());
    let never_started = |_posture| -> DriverStep {
        panic!("a run that ended during its gate never reaches its driver")
    };
    let mut turn = turn_start(run_id, never_started);
    turn.execution_posture = compose_execution_posture(
        PermissionLevel::Sandboxed,
        FilesystemPath::new(git_folder.to_string_lossy().into_owned()).expect("a valid path"),
    );
    let request = RunStartRequest {
        turn,
        queue_item: None,
        provider: test_provider(),
        output_speed: None,
        running_statements: None,
    };
    // The posture gate's read of the root, held until the run has ended.
    let held = hold_reads_of(&git_folder);

    let engine_ref = &engine;
    let end_during_gate = async move {
        held.wait_for_arrival().await;
        let routed = engine_ref
            .route_interrupt(run_id)
            .await
            .expect("the interrupt is routed");
        assert!(matches!(routed, InterruptRoute::Claimed), "{routed:?}");
        engine_ref
            .transition(
                RunStateChange {
                    expected_state: Some(RunState::Starting),
                    ..RunStateChange::new(
                        run_id,
                        RunStateEntry::Interrupted {
                            intended_close: None,
                            trigger: None,
                        },
                    )
                },
                RunStateChangeCompanions::default(),
            )
            .await
            .expect("the run's end is written");
        drop(held);
    };
    let (started, ()) = tokio::time::timeout(SETTLE_WAIT, async {
        tokio::join!(Box::pin(engine.start_run(request)), end_during_gate)
    })
    .await
    .expect("the start and the end settle");

    let refusal = started.expect_err("a run that ended during its gate is not started");
    assert!(
        matches!(
            refusal,
            RunEngineError::Refused(RunRefusal::InvalidTransition { .. })
        ),
        "{refusal:?}"
    );
    assert_eq!(
        engine.execution_postures.resolved_posture_for(&run_id),
        None
    );
}

// A continue whose turn its driver started, its run then ending some other way before `running`
// is written, interrupts no turn, since the ended run holds none, and lets the posture its gate
// resolved go. Killed by interrupting the driver's turn of a run that ended meanwhile.
#[tokio::test]
async fn a_continue_whose_run_ends_after_its_driver_starts_interrupts_no_turn() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    database
        .reader()
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version)
             VALUES (?1, ?2, 'interrupted', 1)",
            params![run_id.text().as_str(), test_session_id().text().as_str()],
        )
        .expect("the test writes the interrupted run");
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let engine = test_engine(&database, log.service, home.path());
    let path = database.path();
    let mut request = continue_request(run_id, move |_posture| {
        end_run_aside(&path, &run_id);
        async { Ok(()) }.boxed()
    });
    let interrupts = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&interrupts);
    request.turn.interrupt_driver = Box::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
        async { Ok(()) }.boxed()
    });

    engine
        .continue_run(request)
        .await
        .expect_err("a continue whose run ended fails");

    assert_eq!(interrupts.load(Ordering::SeqCst), 0);
    assert_eq!(
        engine.execution_postures.resolved_posture_for(&run_id),
        None
    );
}
