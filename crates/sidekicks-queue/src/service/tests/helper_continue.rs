//! A paused helper the person continued under a lead the daemon's restart holds: its lead's
//! continue, handed to the queue's own task, that the provider failed.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::FutureExt as _;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::daemon::recovery::DaemonRecoveryHaltedRun;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::{AgentRunResumeRequest, RunFailureCategory};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::session_control::{
    DriverResumeResult, ProviderTurnAnswer, ResumedRunAnswer,
};
use sidekicks_provider::driver::test_registry::bind_run_to_first_provider;
use sidekicks_session::queue_store::RecordedQueueItemState;
use sidekicks_std::mutex_lock::lock;
use tokio::time::timeout;

use super::{DriverCalls, WAIT, fixture, recording_driver};

// A helper the restart cut, continued while its lead is held with no process, moves to `running`
// and hands the lead's continue to the queue's task; the provider failing that continue halts the
// helper in the recovery status as the provider's failure and moves it back to `paused`, its
// message still kept for its words, so the person's next continue tries again. Killed by the
// restore dropped, which leaves it `running`, and by its words settled on the failure.
#[tokio::test]
async fn a_failed_helper_continue_halts_and_pauses_the_helper_with_its_words_kept() {
    let calls = Arc::new(DriverCalls::default());
    let mut driver = recording_driver(&calls);
    let resumes = Arc::new(AtomicUsize::new(0));
    driver.expect_resume_session().returning({
        let resumes = Arc::clone(&resumes);
        move |params| {
            // The helper's own continue finds the lead held and opens no process; the lead's
            // continue after it fails.
            let opening = resumes.fetch_add(1, Ordering::SeqCst) == 0;
            let runs = params
                .live_runs
                .iter()
                .map(|run| ResumedRunAnswer {
                    run_id: run.run_id,
                    turn: ProviderTurnAnswer::Waiting,
                })
                .collect();
            async move {
                if opening {
                    Ok(DriverResumeResult::Deferred { runs })
                } else {
                    Err(DriverError::Internal("the test's resume fails".into()))
                }
            }
            .boxed()
        }
    });
    let fixture = fixture(driver).await;
    let lead = fixture.insert_run("waitingForApproval").await;
    fixture.set_run_state(lead, "running");
    let binding_id = bind_run_to_first_provider(&fixture.database, lead);
    let reader = fixture.database.reader();
    reader
        .execute(
            "UPDATE runtime_bindings SET resume_handle = 'conversation-1' WHERE id = ?1",
            [binding_id.as_str()],
        )
        .expect("the test gives the lead's binding a conversation");
    let helper = fixture.insert_run("paused").await;
    reader
        .execute(
            "UPDATE runs SET parent_run_id = ?1, reached_by = 'providerSubagent' WHERE run_id = ?2",
            params![lead.text().as_str(), helper.text().as_str()],
        )
        .expect("the test makes the run the lead's helper");
    fixture.insert_event(
        lead,
        SessionEventType::AgentSubagentStarted,
        &json!({
            "sessionId": fixture.session_id.text().as_str(),
            "runId": lead.text().as_str(),
            "provider": PROVIDERS[0].id,
            "subagentId": "helper-1",
            "childRunId": helper.text().as_str(),
        }),
    );
    // The restart's cut of the helper's first turn, which a turn end row records with its turn.
    let turn_end = SessionEventType::AgentTurnInterrupted;
    reader
        .execute(
            "INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns,
               category, type, payload, run_id, run_version, turn_number)
             SELECT ?1, ?2, MAX(sequence) + 1, ?3, 0, ?4, ?5, ?6, ?7, 1, 1
             FROM session_events WHERE session_id = ?2",
            params![
                mint_uuid_v7().to_string(),
                fixture.session_id.text().as_str(),
                WireInstant::now().as_str(),
                turn_end.category().as_str(),
                turn_end.as_str(),
                json!({ "cause": "daemonRestart" }).to_string(),
                helper.text().as_str(),
            ],
        )
        .expect("the test writes the helper's cut");
    let item_id = fixture.queue_message(helper).await;

    timeout(
        WAIT,
        fixture.queue.pauses.resume(
            &AgentRunResumeRequest {
                target_run_id: helper,
                expected_run_version: SafeInt::new(1).expect("a version"),
            },
            &fixture.queue.delivery,
        ),
    )
    .await
    .expect("the continue answers")
    .expect("the helper is continued");
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the lead's continue ends");

    assert_eq!(resumes.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.run_state(helper), "paused");
    assert_eq!(
        lock(&fixture.halted_runs.0).clone(),
        [(
            fixture.session_id,
            DaemonRecoveryHaltedRun {
                run_id: helper,
                recovery_condition: RecoveryCondition::RecoveryNeeded,
                failure_category: Some(RunFailureCategory::ProviderFailure),
            }
        )]
    );
    let kept = fixture
        .queue
        .delivery
        .kept_helper_words(fixture.session_id)
        .await
        .expect("the kept words read");
    assert_eq!(
        kept.get(&helper).map(|words| words.message_ids.clone()),
        Some(vec![item_id])
    );
    assert_eq!(
        fixture.stored_state(item_id),
        RecordedQueueItemState::Queued
    );
}
