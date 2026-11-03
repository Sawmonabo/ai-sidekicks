//! Paused and pausing runs at a restart: a paused run is no work in progress, a pausing one is,
//! so the pass opens a session for a pausing run and none for paused runs alone.

use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_approval::service::test_fixture::SETTLE_WAIT;
use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
use sidekicks_provider::driver::run_control::{
    ApplyInterventionResponse, InterventionResultStatus,
};
use sidekicks_provider::driver::session_control::{
    DriverResumeResult, ProviderTurnAnswer, ResumeSessionParams, ResumedRunAnswer,
};
use sidekicks_session::run::engine::test_fixture::stored_run_state;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::test_run_id;
use tokio::sync::oneshot;
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
        Arc::new(resuming_driver(1, answer)) as Arc<dyn ProviderDriver>
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

// A run the person paused is no work in progress. A session whose live runs are all paused is not
// opened, though its conversation could be resumed, and its paused run stays paused. A session
// with a running run beside a paused one and a pausing one is resumed for both runs in progress:
// the paused one, though the resume names it, stays paused and is not counted resumed, while the
// pausing one, whose turn the provider still runs and whose step limit's `accepted` row stops it,
// is counted resumed, re-armed with the turn's cut and has that row carried out once: while the
// driver holds the interrupt it still reads pausing with the cut held, and once applied it ends
// interrupted at the step limit, its turn with it. Nothing else fails or is interrupted. Killed by
// the paused session opened (the first provider's driver, which expects no resume, is called), by
// a paused lead failed (a run reads `failed`), by a paused run counted resumed (3 resumed), by the
// pausing run left un-armed (no cut is held), and by the limit's row not carried out (the driver's
// one call never comes).
#[tokio::test]
async fn a_pass_keeps_paused_runs_paused_and_opens_no_session_for_them() {
    let unopened = MockProviderDriver::new();
    let mut resumed = resuming_driver(1, |params| {
        resumed_on(params, params.binding_id.clone(), still_running)
    });
    let (called, call) = oneshot::channel::<()>();
    let (release, released) = oneshot::channel::<()>();
    let held_call = Mutex::new(Some((called, released)));
    resumed
        .expect_apply_intervention()
        .times(1)
        .returning(move |_| {
            let (called, released) = lock(&held_call)
                .take()
                .expect("the one call takes the hold");
            called.send(()).expect("the test waits for the call");
            async move {
                released.await.expect("the test releases the call");
                Ok(ApplyInterventionResponse {
                    status: InterventionResultStatus::Applied,
                    fallback_action: None,
                    delivered_run_id: None,
                    canceled: Vec::new(),
                })
            }
            .boxed()
        });
    let fixture = PassFixture::over_drivers(vec![
        Arc::new(unopened) as Arc<dyn ProviderDriver>,
        Arc::new(resumed),
    ])
    .await;
    fixture.end_seeded_run();
    let paused_session = fixture.new_session();
    let paused_run = test_run_id();
    insert_runs(
        &fixture.store.database,
        paused_session,
        &[(paused_run, "paused")],
    );
    fixture.bind_resumable(paused_run, 0).await;
    let (mixed_session, running_run, _) = fixture.running_session(1).await;
    let (paused_beside, pausing_beside) = (test_run_id(), test_run_id());
    insert_runs(
        &fixture.store.database,
        mixed_session,
        &[(paused_beside, "paused"), (pausing_beside, "pausing")],
    );
    fixture
        .append(
            mixed_session,
            json!({
                "type": "agent.turn.started",
                "payload": {"sessionId": mixed_session, "runId": pausing_beside, "runVersion": 0,
                            "turnNumber": 1},
            }),
        )
        .await;
    fixture.record_intervention(
        pausing_beside,
        "interrupt",
        "accepted",
        r#"{"limit":"stepLimit","turnNumber":1}"#,
    );
    let mut changes = fixture.followers.change_count(&mixed_session);

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;
    tokio::time::timeout(SETTLE_WAIT, call)
        .await
        .expect("the limit's row is carried out")
        .expect("the driver signals its call");
    let turn = SafeInt::new(1).expect("turn 1 is a turn number");
    assert_eq!(
        stored_run_state(&fixture.store.database, &pausing_beside).0,
        "pausing"
    );
    assert_eq!(
        fixture.engine.held_cut_limit(pausing_beside, turn),
        Some(RunLimit::StepLimit)
    );
    release.send(()).expect("the call waits for its release");
    tokio::time::timeout(SETTLE_WAIT, async {
        while stored_run_state(&fixture.store.database, &pausing_beside).0 != "interrupted" {
            changes
                .changed()
                .await
                .expect("the session's changes are followed");
        }
    })
    .await
    .expect("the pausing run ends at its step limit");

    for (run_id, state) in [
        (paused_run, "paused"),
        (running_run, "running"),
        (paused_beside, "paused"),
    ] {
        assert_eq!(
            stored_run_state(&fixture.store.database, &run_id).0,
            state,
            "{run_id}"
        );
    }
    for (session_id, interrupted) in [(paused_session, 0), (mixed_session, 1)] {
        assert_eq!(
            fixture.payloads(&session_id, SessionEventType::AgentRunFailed),
            Vec::<Value>::new()
        );
        assert_eq!(
            fixture
                .payloads(&session_id, SessionEventType::AgentRunInterrupted)
                .len(),
            interrupted
        );
    }
    assert_eq!(
        fixture
            .run_trigger(mixed_session, pausing_beside)
            .as_deref(),
        Some("stepLimit")
    );
    let turn_ends = fixture.run_payloads(
        mixed_session,
        SessionEventType::AgentTurnInterrupted,
        pausing_beside,
    );
    let [turn_end] = turn_ends.as_slice() else {
        panic!("the pausing run's turn ended once: {turn_ends:?}");
    };
    assert_eq!(turn_end["cause"], json!("stepLimit"));
    assert_eq!(fixture.binding_count(paused_run), 1);
    let succeeded = fixture.payloads(
        &DAEMON_SCOPE_SENTINEL_SESSION_ID,
        SessionEventType::DaemonRecoverySucceeded,
    );
    let [succeeded] = succeeded.as_slice() else {
        panic!("one pass succeeded: {succeeded:?}");
    };
    assert_eq!(succeeded["runsResumed"], json!(2));
    assert_eq!(succeeded["runsFailedDeterministically"], json!(0));
}
