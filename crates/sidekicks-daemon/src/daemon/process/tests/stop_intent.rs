use std::sync::Arc;
use std::time::{Duration, Instant};

use rstest::rstest;
use rusqlite::Connection;
use sidekicks_contracts::run::id::RunId;
use sidekicks_provider::driver::test_registry::stand_in_codex_service;
use sidekicks_recovery::stop_intent::StopIntent;
use sidekicks_store::database::connection::writer_open::DAEMON_DATABASE_FILE_NAME;
use tokio_util::sync::CancellationToken;

use super::restart::{SeededCodexRun, stand_in_test, stored_run_state};
use super::{STOP_WAIT, TestHome};
use crate::daemon::process::database::DatabaseFileOpenError;
use crate::daemon::process::start_error::DaemonStartError;
use crate::daemon::process::stop::{
    DaemonStopFailure, DaemonStopReason, close_data_folder, stop_work,
};
use crate::daemon::start_stopped_error::DaemonStartStoppedError;

// The drain bound each stop here takes: far past what any step needs on a loaded machine, so the
// cases prove which stop drains rather than how fast the machine runs; the bound's own value is
// proven by the stop with none.
const DRAIN_BOUND: Duration = Duration::from_secs(60);

// How the started daemon stops.
#[derive(Clone, Copy, Debug)]
enum Case {
    // `daemon.stop`, within the drain bound.
    Stop,
    // `daemon.stop` with no time left for the drain.
    StopWithNoBound,
    // `daemon.restart`.
    Restart,
    // The system's stop request.
    SystemStop,
    // A start that failed for another reason, released.
    FailedStart,
    // The erase's step that ends the work.
    EraseStep,
    // A start the person's Stop cut short over the repairing socket, released.
    StopCutTheRepair,
    // The person's Stop asked after the process took a restart.
    StopAfterRestart,
    // `daemon.stop` with a folder where the intent's file goes.
    FailedWrite,
    // The erase's step, then the person's Stop.
    StopAfterErase,
}

// What the stop leaves of the intent.
#[derive(Debug, PartialEq, Eq)]
enum IntentLeft {
    // No file.
    None,
    // The intent, whole.
    Whole,
    // A folder in its place, which the write could not replace.
    Unwritable,
}

// The trigger of `run_id`'s one `interrupted` end in `home`'s store.
fn interrupted_trigger(home: &TestHome, run_id: RunId) -> Option<String> {
    let connection = Connection::open(home.data_folder().join(DAEMON_DATABASE_FILE_NAME))
        .expect("the store opens");
    let mut statement = connection
        .prepare("SELECT payload FROM session_events WHERE type = 'agent.run.interrupted'")
        .expect("the read prepares");
    let ends = statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("the ends read")
        .map(|payload| {
            serde_json::from_str::<serde_json::Value>(&payload.expect("a payload reads"))
                .expect("a JSON payload")
        })
        .filter(|payload| payload["runId"].as_str() == Some(run_id.text().as_str()))
        .collect::<Vec<_>>();
    let [end] = ends.as_slice() else {
        panic!("run {run_id} ended interrupted once: {ends:?}");
    };
    end["trigger"].as_str().map(str::to_owned)
}

// Only the person's Stop writes the stop intent, whole, and drains the live runs once the drivers
// are shut down: a Stop asked after the process took a restart writes and drains too, a failed
// write is one of the stop's failures and the drain still runs, a Stop with no time left leaves the
// run live for the next start, which ends it by the Stop and resumes nothing, and each stop counts
// its bound from its own start. A restart, the system's stop, a failed start and the erase's step
// write nothing and leave the run live. Killed by the drain dropped, by the write dropped, by the
// write keyed on the drivers' intent (the erase writes), by a failed start's release ignoring its
// reason, by the second read of the ask not writing, by a failed write swallowed or ending the
// drain, and by a stop's start kept from an earlier stop.
#[rstest]
#[case::stop(Case::Stop)]
#[case::stop_with_no_bound(Case::StopWithNoBound)]
#[case::restart(Case::Restart)]
#[case::system_stop(Case::SystemStop)]
#[case::failed_start(Case::FailedStart)]
#[case::erase_step(Case::EraseStep)]
#[case::stop_cut_the_repair(Case::StopCutTheRepair)]
#[case::stop_after_restart(Case::StopAfterRestart)]
#[case::failed_write(Case::FailedWrite)]
#[case::stop_after_erase(Case::StopAfterErase)]
#[tokio::test(flavor = "multi_thread")]
async fn only_a_persons_stop_writes_the_intent_and_drains(#[case] case: Case) {
    let home = TestHome::new();
    let Some(stand_in) = stand_in_codex_service(
        &stand_in_test(),
        &home.run_folder.socket_path,
        &home.data_folder(),
    ) else {
        return;
    };
    let seeded = SeededCodexRun::seed(&home).await;
    let home = home.with_provider_environment(SeededCodexRun::provider_environment(
        &stand_in,
        "inProgress",
    ));
    let system_stop = CancellationToken::new();
    let mut process = home
        .start(system_stop.clone())
        .await
        .expect("the daemon starts");
    let stop_intent = Arc::clone(&process.stop_intent);
    assert_eq!(stored_run_state(&home, seeded.run_id), "running");

    let (failures, process) = match case {
        Case::Stop | Case::FailedWrite => {
            if matches!(case, Case::FailedWrite) {
                std::fs::create_dir(stop_intent.path()).expect("a folder takes the file's place");
            }
            let failures = stop_work(&mut process, DaemonStopReason::Stop, DRAIN_BOUND).await;
            (failures, Some(process))
        }
        Case::StopWithNoBound => {
            let failures = stop_work(&mut process, DaemonStopReason::Stop, Duration::ZERO).await;
            (failures, Some(process))
        }
        Case::Restart => {
            let failures = stop_work(&mut process, DaemonStopReason::Restart, DRAIN_BOUND).await;
            (failures, Some(process))
        }
        Case::SystemStop => {
            system_stop.cancel();
            let reason = tokio::time::timeout(STOP_WAIT, process.wait_for_stop())
                .await
                .expect("the system's stop reaches the process");
            let failures = stop_work(&mut process, reason, DRAIN_BOUND).await;
            (failures, Some(process))
        }
        Case::EraseStep => {
            let failures = stop_work(&mut process, DaemonStopReason::Erase, DRAIN_BOUND).await;
            (failures, Some(process))
        }
        Case::FailedStart => {
            let error = DaemonStartError::Stopped(DaemonStartStoppedError {
                step: "binding the socket",
            });
            drop(process.release(error).await);
            (Vec::new(), None)
        }
        Case::StopCutTheRepair => {
            let error = DaemonStartError::DatabaseFile(DatabaseFileOpenError::Stopped(
                DaemonStopReason::Stop,
            ));
            drop(process.release(error).await);
            (Vec::new(), None)
        }
        Case::StopAfterRestart => {
            (process.accept_stop())(DaemonStopReason::Stop);
            let failures = stop_work(&mut process, DaemonStopReason::Restart, DRAIN_BOUND).await;
            (failures, Some(process))
        }
        Case::StopAfterErase => {
            let mut failures = stop_work(&mut process, DaemonStopReason::Erase, DRAIN_BOUND).await;
            let between = Instant::now();
            failures.extend(stop_work(&mut process, DaemonStopReason::Stop, DRAIN_BOUND).await);
            assert!(
                process.stop_started.expect("the stop began") >= between,
                "the Stop counts its bound from the erase's step"
            );
            (failures, Some(process))
        }
    };
    let run_state = stored_run_state(&home, seeded.run_id);
    let intent_left = if !stop_intent.path().exists() {
        IntentLeft::None
    } else if stop_intent.path().is_dir() {
        IntentLeft::Unwritable
    } else {
        assert_eq!(stop_intent.read().await, Some(StopIntent::Whole));
        IntentLeft::Whole
    };
    if let Some(mut process) = process {
        drop(close_data_folder(&mut process).await);
    }

    let (intent, state) = match case {
        Case::Stop | Case::StopCutTheRepair | Case::StopAfterRestart | Case::StopAfterErase => {
            (IntentLeft::Whole, "interrupted")
        }
        Case::StopWithNoBound => (IntentLeft::Whole, "running"),
        Case::FailedWrite => (IntentLeft::Unwritable, "interrupted"),
        Case::Restart | Case::SystemStop | Case::FailedStart | Case::EraseStep => {
            (IntentLeft::None, "running")
        }
    };
    assert_eq!(intent_left, intent);
    assert_eq!(run_state, state);
    if state == "interrupted" {
        assert_eq!(
            interrupted_trigger(&home, seeded.run_id).as_deref(),
            Some("daemonStop")
        );
    }
    assert_eq!(
        failures
            .iter()
            .any(|failure| matches!(failure, DaemonStopFailure::StopIntent(_))),
        matches!(case, Case::FailedWrite),
        "{failures:?}"
    );
    if matches!(case, Case::StopWithNoBound) {
        let connections_before = stand_in.connections().len();
        let next = home
            .start(CancellationToken::new())
            .await
            .expect("the next daemon starts");
        let next_state = stored_run_state(&home, seeded.run_id);
        let connections = stand_in.connections();
        next.stop(DaemonStopReason::Restart)
            .await
            .expect("the next daemon's stop fails nothing");

        assert_eq!(next_state, "interrupted", "the next start ends the run");
        assert_eq!(
            interrupted_trigger(&home, seeded.run_id).as_deref(),
            Some("daemonStop")
        );
        let next_connections = connections
            .get(connections_before..)
            .expect("the first daemon's connections stay recorded");
        assert!(
            next_connections.iter().all(|connection| !connection
                .methods
                .iter()
                .any(|method| method == "thread/resume")),
            "the next start resumed the run: {next_connections:?}"
        );
        assert!(
            !stop_intent.path().exists(),
            "the next start's pass drops the intent"
        );
    }
}
