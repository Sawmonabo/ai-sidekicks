//! A lone pausing lead at a restart: work in progress, so the pass opens its session.

use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::session_control::{
    DriverResumeResult, ProviderTurnAnswer, ResumeSessionParams, ResumedRunAnswer,
};
use sidekicks_session::run::engine::test_fixture::stored_run_state;
use sidekicks_store::database::writer::test_file::test_run_id;
use tokio_util::sync::CancellationToken;

use super::{resumed_on, resuming_driver, still_running};
use crate::test_pass::{PassFixture, insert_runs};

// The conversation relaunched under the binding the resume minted, the lead's turn still running.
fn relaunched_still_running(params: &ResumeSessionParams) -> DriverResumeResult {
    resumed_on(params, params.binding_id.clone(), still_running)
}

// No process started, every run the resume names answered with its turn gone, as a provider that
// defers a lone pausing lead answers.
fn deferred_turn_gone(params: &ResumeSessionParams) -> DriverResumeResult {
    DriverResumeResult::Deferred {
        runs: params
            .live_runs
            .iter()
            .map(|run| ResumedRunAnswer {
                run_id: run.run_id,
                turn: ProviderTurnAnswer::Gone,
            })
            .collect(),
    }
}

// A session whose only live run is a pausing lead with its first turn open is opened, since the
// lead is in progress. A provider whose turn still runs leaves the lead pausing, its turn open, and
// the lead is counted resumed under the binding the resume recorded; a provider that defers the
// lead answers its turn gone, so the lead reaches its pause with that turn ended by the restart,
// counted nowhere and with no binding recorded. Killed by a pausing run kept out of the runs in
// progress (the session is not opened, so the driver's one resume is missed, in both cases), by a
// pausing run the resume named counted nowhere (`still_running` reads 0 resumed), and by the gone
// turn left open (`deferred` writes no turn end).
#[rstest]
#[case::still_running(relaunched_still_running, "pausing", &[], 1, 2)]
#[case::deferred(deferred_turn_gone, "paused", &["daemonRestart"], 0, 1)]
#[tokio::test]
async fn a_lone_pausing_lead_opens_its_session(
    #[case] answer: fn(&ResumeSessionParams) -> DriverResumeResult,
    #[case] run_state: &str,
    #[case] turn_end_causes: &[&str],
    #[case] runs_resumed: u64,
    #[case] bindings: i64,
) {
    let fixture = PassFixture::over_drivers(vec![
        Arc::new(resuming_driver(answer)) as Arc<dyn ProviderDriver>
    ])
    .await;
    fixture.end_seeded_run();
    let session_id = fixture.new_session();
    let lead = test_run_id();
    insert_runs(&fixture.store.database, session_id, &[(lead, "pausing")]);
    fixture.bind_resumable(lead, 0).await;
    fixture.open_turn(session_id, lead, None).await;

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;

    assert_eq!(
        stored_run_state(&fixture.store.database, &lead).0,
        run_state
    );
    let causes: Vec<Value> = fixture
        .run_payloads(session_id, SessionEventType::AgentTurnInterrupted, lead)
        .iter()
        .map(|turn_end| turn_end["cause"].clone())
        .collect();
    assert_eq!(
        causes,
        turn_end_causes
            .iter()
            .map(|cause| json!(cause))
            .collect::<Vec<_>>()
    );
    assert_eq!(fixture.binding_count(lead), bindings);
    let succeeded = fixture.payloads(
        &DAEMON_SCOPE_SENTINEL_SESSION_ID,
        SessionEventType::DaemonRecoverySucceeded,
    );
    let [succeeded] = succeeded.as_slice() else {
        panic!("one pass succeeded: {succeeded:?}");
    };
    assert_eq!(succeeded["runsResumed"], json!(runs_resumed));
}
